/**
 * Self-test for storylines-demo-seed.sql and storylines-demo-cleanup.sql against throwaway
 * Postgres servers: one whose cluster_name ends in "-dev", and any number that must be refused.
 *
 *   docker run -d --rm --name sl-dev    -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55901:5432 postgres:16-alpine -c cluster_name=sl-dev
 *   docker run -d --rm --name sl-prodev -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55902:5432 postgres:16-alpine -c cluster_name=sl-prodev
 *   docker run -d --rm --name sl-devpr  -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55903:5432 postgres:16-alpine -c cluster_name=dev-prod
 *   docker run -d --rm --name sl-noname -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55904:5432 postgres:16-alpine
 *   DEV_URL=postgres://postgres:pw@127.0.0.1:55901/postgres \
 *   NONDEV_URLS=postgres://postgres:pw@127.0.0.1:55902/postgres,postgres://postgres:pw@127.0.0.1:55903/postgres,postgres://postgres:pw@127.0.0.1:55904/postgres \
 *   node scripts/storylines/storylines-demo-seed.selftest.mjs
 *
 * The refused names are traps: "sl-prodev" ends in "dev" without the hyphen, "dev-prod" starts
 * with it, and the last server sets no name. Every server is wiped and rebuilt on each run, so
 * never point this at a real one.
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

const COMMUNITY_OFF = "community_name CONSTANT text := '';";
assert.equal(seedSql.split(COMMUNITY_OFF).length, 2, 'seed must declare community_name once');
const seedWithCommunitySql = seedSql.replace(COMMUNITY_OFF, () =>
  COMMUNITY_OFF.replace("''", "'Someone'")
);

const { DEV_URL, NONDEV_URLS } = process.env;
if (!DEV_URL || !NONDEV_URLS) {
  console.error('DEV_URL and NONDEV_URLS are required (see the header of this file).');
  process.exit(2);
}

// Posts are laid out so that each filter in the seed changes the outcome when removed:
// - 102 is published after 103, so ordering by id instead of publishedAt picks differently;
// - 104, 206 (above the ceiling), 105 (unpublished), 106 (level 0), 107/108/208 (already a
//   chapter of another storyline) and 209 (Blocked only) all sort ahead of the posts that
//   should be picked, so dropping the filter that excludes them changes the storyline;
// - 207 is unpublished and above the ceiling, for the no-candidate check at the end.
const FIXTURE = `
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
CREATE TABLE "User" (id int PRIMARY KEY, username text, "deletedAt" timestamp);
CREATE TABLE "Report" (id int PRIMARY KEY);
CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp, "nsfwLevel" int NOT NULL DEFAULT 0);
CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, index int);
INSERT INTO "User" VALUES (10, 'CivBot', NULL), (20, 'CivChan', NULL), (30, 'Someone', NULL);
INSERT INTO "Post" VALUES
  (101, 10, '2025-01-01', 1), (103, 10, '2025-01-02', 3), (102, 10, '2025-01-03', 3),
  (104, 10, '2024-12-30', 4), (105, 10, NULL, 1), (106, 10, '2024-12-01', 0),
  (107, 10, '2024-11-01', 1), (108, 10, '2024-11-01', 4),
  (201, 20, '2025-01-01', 1), (202, 20, '2025-01-02', 1), (203, 20, '2025-01-03', 3),
  (204, 20, '2025-01-04', 7), (205, 20, NULL, 1), (206, 20, '2024-12-31', 4),
  (207, 20, NULL, 8), (208, 20, '2024-11-01', 1), (209, 20, '2024-11-02', 32),
  (301, 30, '2025-01-01', 1);
INSERT INTO "Image" VALUES
  (1001, 101, 0), (1002, 101, 1), (1003, 101, 2),
  (2005, 202, 2), (2009, 202, 0), (2007, 202, 1);
`;

// Other storylines the seed and cleanup must leave alone. "Prior" already uses posts 107, 108
// and 208; the two decoys each share one half of the demo's (owner, title) key.
const OTHER_STORYLINES = `
INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
  (901, 30, 'Prior', 4, now()), (902, 10, 'Other', 1, now()), (903, 20, 'The Patch', 1, now());
SELECT setval(pg_get_serial_sequence('"Storyline"', 'id'), 1000);
INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth) VALUES
  (901, 107, 10, 0), (901, 208, 20, 1), (901, 108, 10, 1);
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

const count = async (c, sql) => Number((await c.query(sql)).rows[0].n);
const demoChapters = (c) =>
  count(
    c,
    `SELECT count(*)::int AS n FROM "StorylineChapter" ch JOIN "Storyline" s ON s.id = ch."storylineId"
     WHERE s.title = 'The Patch' AND s."userId" = 10`
  );
const digest = async (c, table) =>
  (
    await c.query(
      `SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS d FROM "${table}" t`
    )
  ).rows[0].d;
const otherStorylines = async (c) =>
  (
    await c.query(
      `SELECT id, "userId", title FROM "Storyline" WHERE id IN (901, 902, 903) ORDER BY id`
    )
  ).rows;

async function prepare(c) {
  await c.query(FIXTURE);
  await c.query(migrationSql);
  await c.query(OTHER_STORYLINES);
}

/** [depth, postId, author, rank, aboveCeiling, parent's postId] for each printed row. */
function shape(rows) {
  const postOf = new Map(rows.map((r) => [r.chapterId, r.postId]));
  return rows.map((r) => [
    r.depth,
    r.postId,
    r.author,
    r.rank,
    r.aboveCeiling,
    r.parentChapterId === null ? null : postOf.get(r.parentChapterId),
  ]);
}

const MAIN = [
  [0, 101, 'CivBot', 'first', false, null],
  [1, 201, 'CivChan', 'canon', false, 101],
  [2, 103, 'CivBot', 'canon', false, 201],
  [3, 202, 'CivChan', 'canon', false, 103],
];
const CANON_END = [4, 102, 'CivBot', 'canon', false, 202];
const ENDORSED_END = [4, 203, 'CivChan', 'endorsed', false, 202];
const COMMUNITY_END = [4, 301, 'Someone', 'community', false, 202];
const ABOVE_CEILING_END = [4, 104, 'CivBot', 'endorsed', true, 202];

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

for (const url of NONDEV_URLS.split(',')) {
  await withClient(url, async (c) => {
    await prepare(c);
    const cluster = (await c.query(`SELECT current_setting('cluster_name') AS n`)).rows[0].n;
    assert.ok(!cluster.endsWith('-dev'), `${url} must not be a *-dev cluster (got "${cluster}")`);
    const before = [await digest(c, 'Storyline'), await digest(c, 'StorylineChapter')];

    await check(`seed refuses cluster_name "${cluster}"`, async () => {
      await assert.rejects(c.query(seedSql), /refusing to run/);
      assert.deepEqual([await digest(c, 'Storyline'), await digest(c, 'StorylineChapter')], before);
    });
    await check(`cleanup refuses cluster_name "${cluster}"`, async () => {
      await assert.rejects(c.query(cleanupSql), /refusing to run/);
      assert.deepEqual([await digest(c, 'Storyline'), await digest(c, 'StorylineChapter')], before);
    });
  });
}

await withClient(DEV_URL, async (c) => {
  await prepare(c);
  const cluster = (await c.query(`SELECT current_setting('cluster_name') AS n`)).rows[0].n;
  assert.ok(cluster.endsWith('-dev'), `DEV_URL must be a *-dev cluster (got "${cluster}")`);
  const posts = await digest(c, 'Post');
  const images = await digest(c, 'Image');
  const others = await otherStorylines(c);

  let rows = [];
  await check('seed builds the demo storyline', async () => {
    rows = (await c.query(seedSql)).at(-1).rows;
    assert.deepEqual(shape(rows), [...MAIN, CANON_END, ENDORSED_END, ABOVE_CEILING_END]);
    const [story] = (
      await c.query(`SELECT * FROM "Storyline" WHERE title = 'The Patch' AND "userId" = 10`)
    ).rows;
    assert.equal(story.maxNsfwLevel, 2);
    assert.deepEqual(
      (
        await c.query(`SELECT "userId" FROM "StorylineCollaborator" WHERE "storylineId" = $1`, [
          story.id,
        ])
      ).rows,
      [{ userId: 20 }]
    );
  });

  await check('seed prints each chapter its own first and last image', async () => {
    const images = rows.map((r) => [r.postId, r.firstImageId, r.lastImageId]);
    assert.deepEqual(images.slice(0, 4), [
      [101, 1001, 1003],
      [201, null, null],
      [103, null, null],
      [202, 2009, 2005],
    ]);
  });

  await check('a second seed run changes nothing', async () => {
    const storylines = await digest(c, 'Storyline');
    const chapters = await digest(c, 'StorylineChapter');
    const edges = await digest(c, 'StorylineChapterEdge');
    await c.query(seedSql);
    assert.equal(await digest(c, 'Storyline'), storylines);
    assert.equal(await digest(c, 'StorylineChapter'), chapters);
    assert.equal(await digest(c, 'StorylineChapterEdge'), edges);
  });

  await check('seed never writes to "Post" or "Image", or to other storylines', async () => {
    assert.equal(await digest(c, 'Post'), posts);
    assert.equal(await digest(c, 'Image'), images);
    assert.deepEqual(await otherStorylines(c), others);
  });

  await check('cleanup removes only the demo storyline', async () => {
    const [{ remainingDemoStorylines }] = (await c.query(cleanupSql)).at(-1).rows;
    assert.equal(remainingDemoStorylines, '0');
    assert.equal(await demoChapters(c), 0);
    assert.deepEqual(await otherStorylines(c), others);
    assert.equal(
      await count(c, `SELECT count(*)::int AS n FROM "StorylineChapter" WHERE "storylineId" = 901`),
      3
    );
    assert.equal(await count(c, `SELECT count(*)::int AS n FROM "StorylineChapterEdge"`), 0);
    assert.equal(await count(c, `SELECT count(*)::int AS n FROM "StorylineCollaborator"`), 0);
    assert.equal(await digest(c, 'Post'), posts);
  });

  await check('a named third account adds a community continuation', async () => {
    const withCommunity = (await c.query(seedWithCommunitySql)).at(-1).rows;
    assert.deepEqual(shape(withCommunity), [
      ...MAIN,
      CANON_END,
      ENDORSED_END,
      COMMUNITY_END,
      ABOVE_CEILING_END,
    ]);
    await c.query(cleanupSql);
  });

  // Unpublished posts sort last, so they are only reached when an account runs short. 105 and
  // 205 are each account's unpublished post at or under the ceiling.
  for (const [account, postId, publishedAt] of [
    ['owner', 102, '2025-01-03'],
    ['collaborator', 203, '2025-01-03'],
  ]) {
    await check(`seed refuses rather than use the ${account}'s unpublished post`, async () => {
      await c.query(`UPDATE "Post" SET "publishedAt" = NULL WHERE id = $1`, [postId]);
      try {
        await assert.rejects(c.query(seedSql), /need 3 posts/);
        assert.equal(await demoChapters(c), 0);
      } finally {
        await c.query(`UPDATE "Post" SET "publishedAt" = $2 WHERE id = $1`, [postId, publishedAt]);
      }
    });
  }

  await check('seed refuses when the only posts above the ceiling are unusable', async () => {
    // Left: 207 (unpublished), 108 (already a chapter) and 209 (Blocked).
    await c.query(`UPDATE "Post" SET "publishedAt" = NULL WHERE id IN (104, 204, 206)`);
    try {
      await assert.rejects(c.query(seedSql), /no post above the ceiling/);
      assert.equal(await demoChapters(c), 0);
    } finally {
      await c.query(
        `UPDATE "Post" SET "publishedAt" = v.d::timestamp FROM (VALUES (104, '2024-12-30'), (204, '2025-01-04'), (206, '2024-12-31')) v(id, d) WHERE "Post".id = v.id`
      );
    }
  });

  await check('seed after cleanup rebuilds the same storyline', async () => {
    assert.equal(await digest(c, 'Post'), posts);
    const again = (await c.query(seedSql)).at(-1).rows;
    assert.deepEqual(shape(again), [...MAIN, CANON_END, ENDORSED_END, ABOVE_CEILING_END]);
  });
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
