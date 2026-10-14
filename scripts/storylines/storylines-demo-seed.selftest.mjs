/**
 * Self-test for storylines-demo-seed.sql and storylines-demo-cleanup.sql against two throwaway
 * Postgres servers: one whose cluster_name ends in "-dev" and one whose does not.
 *
 *   docker run -d --rm --name sl-dev    -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55901:5432 postgres:16-alpine -c cluster_name=sl-dev
 *   docker run -d --rm --name sl-nondev -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55902:5432 postgres:16-alpine -c cluster_name=sl-other
 *   DEV_URL=postgres://postgres:pw@127.0.0.1:55901/postgres \
 *   NONDEV_URL=postgres://postgres:pw@127.0.0.1:55902/postgres \
 *   node scripts/storylines/storylines-demo-seed.selftest.mjs
 *
 * Each server gets a minimal "User" / "Post" / "Report" fixture plus the real storylines
 * migration. Both servers are wiped and rebuilt on every run, so never point this at a real one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const seedSql = read('scripts/storylines/storylines-demo-seed.sql');
const cleanupSql = read('scripts/storylines/storylines-demo-cleanup.sql');
const migrationSql = read(
  'packages/civitai-db-schema/prisma/migrations/20261023120000_storylines/migration.sql'
);

const { DEV_URL, NONDEV_URL } = process.env;
if (!DEV_URL || !NONDEV_URL) {
  console.error('DEV_URL and NONDEV_URL are required (see the header of this file).');
  process.exit(2);
}

const FIXTURE = `
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
CREATE TABLE "User" (id int PRIMARY KEY, username text, "deletedAt" timestamp);
CREATE TABLE "Report" (id int PRIMARY KEY);
CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp, "nsfwLevel" int NOT NULL DEFAULT 0);
CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, index int);
INSERT INTO "Image" VALUES (1001, 101, 0), (1002, 101, 1), (1003, 101, 2);
INSERT INTO "User" VALUES (10, 'CivBot', NULL), (20, 'CivChan', NULL), (30, 'Someone', NULL);
INSERT INTO "Post" VALUES
  (101, 10, '2025-01-01', 1), (102, 10, '2025-01-02', 3), (103, 10, '2025-01-03', 3),
  (201, 20, '2025-01-01', 1), (202, 20, '2025-01-02', 1), (203, 20, '2025-01-03', 3),
  (204, 20, '2025-01-04', 7),
  -- Earliest posts of each account are above the ceiling, so a dropped ceiling filter shows.
  (104, 10, '2024-12-30', 4), (206, 20, '2024-12-31', 4),
  (205, 20, NULL, 1),
  (301, 30, '2025-01-01', 1);
`;

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const count = async (c, table) =>
  Number((await c.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);
const postsDigest = async (c) =>
  (await c.query(`SELECT md5(string_agg(p::text, ',' ORDER BY id)) AS d FROM "Post" p`)).rows[0].d;

async function prepare(c) {
  await c.query(FIXTURE);
  await c.query(migrationSql);
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`);
  }
}

await withClient(NONDEV_URL, async (c) => {
  await prepare(c);
  const cluster = (await c.query(`SELECT current_setting('cluster_name') AS n`)).rows[0].n;
  assert.ok(!cluster.endsWith('-dev'), `NONDEV_URL must not be a *-dev cluster (got "${cluster}")`);

  await check('seed refuses a server whose cluster_name does not end in -dev', async () => {
    await assert.rejects(c.query(seedSql), /refusing to run/);
    assert.equal(await count(c, 'Storyline'), 0);
    assert.equal(await count(c, 'StorylineChapter'), 0);
  });
  await check('cleanup refuses a server whose cluster_name does not end in -dev', async () => {
    await assert.rejects(c.query(cleanupSql), /refusing to run/);
  });
});

await withClient(DEV_URL, async (c) => {
  await prepare(c);
  const cluster = (await c.query(`SELECT current_setting('cluster_name') AS n`)).rows[0].n;
  assert.ok(cluster.endsWith('-dev'), `DEV_URL must be a *-dev cluster (got "${cluster}")`);
  const before = await postsDigest(c);

  let rows;
  await check('seed builds the demo storyline', async () => {
    const results = await c.query(seedSql);
    rows = results.at(-1).rows;
    const shape = rows.map((r) => [r.depth, r.postId, r.author, r.rank, r.aboveCeiling]);
    assert.deepEqual(shape, [
      [0, 101, 'CivBot', 'first', false],
      [1, 201, 'CivChan', 'canon', false],
      [2, 102, 'CivBot', 'canon', false],
      [3, 202, 'CivChan', 'canon', false],
      [4, 103, 'CivBot', 'canon', false],
      [4, 203, 'CivChan', 'endorsed', false],
      [4, 104, 'CivBot', 'endorsed', true],
    ]);
    const [{ maxNsfwLevel, status }] = (await c.query(`SELECT * FROM "Storyline"`)).rows;
    assert.deepEqual([rows[0].firstImageId, rows[0].lastImageId], [1001, 1003]);
    assert.equal(maxNsfwLevel, 2);
    assert.equal(status, 'Ongoing');
    assert.equal(await count(c, 'StorylineChapterEdge'), 6);
    assert.deepEqual((await c.query(`SELECT "userId" FROM "StorylineCollaborator"`)).rows, [
      { userId: 20 },
    ]);
  });

  await check('all three continuations hang off the last main chapter', async () => {
    const last = rows.find((r) => r.depth === 3).chapterId;
    const ends = rows.filter((r) => r.depth === 4);
    assert.equal(ends.length, 3);
    for (const r of ends) assert.equal(r.parentChapterId, last);
  });

  await check('a second seed run changes nothing', async () => {
    await c.query(seedSql);
    assert.equal(await count(c, 'Storyline'), 1);
    assert.equal(await count(c, 'StorylineChapter'), 7);
    assert.equal(await count(c, 'StorylineChapterEdge'), 6);
  });

  await check('seed never writes to "Post"', async () => {
    assert.equal(await postsDigest(c), before);
  });

  await check('cleanup removes the storyline and everything hanging from it', async () => {
    await c.query(
      `INSERT INTO "Storyline" ("userId", title, "maxNsfwLevel", "updatedAt") VALUES (20, 'Not the demo', 1, now())`
    );
    const results = await c.query(cleanupSql);
    assert.equal(results.at(-1).rows[0].remainingDemoStorylines, '0');
    assert.deepEqual((await c.query(`SELECT title FROM "Storyline"`)).rows, [
      { title: 'Not the demo' },
    ]);
    assert.equal(await count(c, 'StorylineChapter'), 0);
    assert.equal(await count(c, 'StorylineChapterEdge'), 0);
    assert.equal(await count(c, 'StorylineCollaborator'), 0);
    assert.equal(await postsDigest(c), before);
  });

  await check('seed after cleanup rebuilds it', async () => {
    await c.query(seedSql);
    assert.equal(await count(c, 'StorylineChapter'), 7);
  });

  await check(
    'seed skips unpublished posts rather than using them to make up the numbers',
    async () => {
      await c.query(cleanupSql);
      await c.query(`UPDATE "Post" SET "publishedAt" = NULL WHERE id = 203`);
      await assert.rejects(c.query(seedSql), /need 3 posts/);
      assert.equal(await count(c, 'StorylineChapter'), 0);
    }
  );
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
