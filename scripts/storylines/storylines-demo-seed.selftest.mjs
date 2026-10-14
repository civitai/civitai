/**
 * Self-test for storylines-demo-seed.sql and storylines-demo-cleanup.sql against throwaway
 * Postgres servers: one whose cluster_name ends in "-dev", and any number that must be refused.
 *
 *   docker run -d --rm --name sl-dev    -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55901:5432 postgres:16-alpine -c cluster_name=sl-dev
 *   docker run -d --rm --name sl-prodev -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55902:5432 postgres:16-alpine -c cluster_name=sl-prodev
 *   docker run -d --rm --name sl-devpr  -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55903:5432 postgres:16-alpine -c cluster_name=dev-prod
 *   docker run -d --rm --name sl-devmid -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55904:5432 postgres:16-alpine -c cluster_name=sl-dev-prod
 *   docker run -d --rm --name sl-noname -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55905:5432 postgres:16-alpine
 *   DEV_URL=postgres://postgres:pw@127.0.0.1:55901/postgres \
 *   NONDEV_URLS=postgres://postgres:pw@127.0.0.1:55902/postgres,postgres://postgres:pw@127.0.0.1:55903/postgres,postgres://postgres:pw@127.0.0.1:55904/postgres,postgres://postgres:pw@127.0.0.1:55905/postgres \
 *   node scripts/storylines/storylines-demo-seed.selftest.mjs
 *
 * The refused names are near misses of "*-dev": no hyphen, a "dev-" prefix, "-dev" in the
 * middle, and no name at all.
 *
 * Every server is wiped and rebuilt. Before touching one, the test refuses any database that
 * already holds more than a handful of users, so a real database pointed at by mistake is left
 * alone; the cluster name cannot protect it, because a real dev server passes that check too.
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
const seedWithCommunity = (name) =>
  seedSql.replace(COMMUNITY_OFF, () => COMMUNITY_OFF.replace("''", `'${name}'`));

const { DEV_URL, NONDEV_URLS } = process.env;
if (!DEV_URL || !NONDEV_URLS) {
  console.error('DEV_URL and NONDEV_URLS are required (see the header of this file).');
  process.exit(2);
}

/** The fixture has 3 users. A database with more was not made by this test. */
const MAX_THROWAWAY_USERS = 10;

async function assertThrowaway(c, url) {
  const { rows } = await c.query(`SELECT to_regclass('public."User"') IS NOT NULL AS has_users`);
  if (!rows[0].has_users) return;
  const n = Number(
    (
      await c.query(
        `SELECT count(*) AS n FROM (SELECT 1 FROM "User" LIMIT ${MAX_THROWAWAY_USERS + 1}) u`
      )
    ).rows[0].n
  );
  if (n > MAX_THROWAWAY_USERS) {
    throw new Error(
      `refusing to wipe ${url}: it already has more than ${MAX_THROWAWAY_USERS} users, so it is not a throwaway database`
    );
  }
}

// Every post filter in the seed changes the outcome when removed, because a post it should
// exclude sorts ahead of the posts it should pick:
// - owner 102/103 and collaborator 201/202 are published in the opposite order to their ids,
//   and 206 is the earliest usable post above the ceiling but has a higher id than 104;
// - 105/205 unpublished, 113 scheduled in the future, 106/306 level 0, 107/108/208/304 already
//   chapters of "Prior", 110/214/211/302 tosViolation, 111/215/212 unlisted, 112/216/213 not
//   Public, 209/210 Blocked (alone and with R), 303 above the ceiling, 310 a third account's
//   post above the ceiling, 207 unpublished and above the ceiling.
const FIXTURE = `
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
CREATE TABLE "User" (id int PRIMARY KEY, username text UNIQUE, "deletedAt" timestamp);
CREATE TABLE "Report" (id int PRIMARY KEY);
CREATE TABLE "Post" (
  id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
  "nsfwLevel" int NOT NULL DEFAULT 0, "tosViolation" boolean NOT NULL DEFAULT false,
  unlisted boolean NOT NULL DEFAULT false, availability text NOT NULL DEFAULT 'Public'
);
CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, index int);
INSERT INTO "User" VALUES (10, 'CivBot', NULL), (20, 'CivChan', NULL), (30, 'Someone', NULL);
INSERT INTO "Post" (id, "userId", "publishedAt", "nsfwLevel") VALUES
  (101, 10, '2025-01-01', 1), (103, 10, '2025-01-02', 3), (102, 10, '2025-01-03', 3),
  (104, 10, '2024-12-30', 4), (105, 10, NULL, 1), (106, 10, '2024-12-01', 0),
  (107, 10, '2024-11-01', 1), (108, 10, '2024-11-01', 4),
  (110, 10, '2024-10-01', 1), (111, 10, '2024-10-02', 1), (112, 10, '2024-10-03', 1),
  (113, 10, '2099-01-01', 1),
  (202, 20, '2025-01-01', 1), (201, 20, '2025-01-02', 1), (203, 20, '2025-01-03', 3),
  (204, 20, '2025-01-04', 7), (205, 20, NULL, 1), (206, 20, '2024-12-29', 4),
  (207, 20, NULL, 8), (208, 20, '2024-11-01', 1), (209, 20, '2024-11-02', 32),
  (210, 20, '2024-11-03', 36),
  (211, 20, '2024-09-01', 4), (212, 20, '2024-09-02', 4), (213, 20, '2024-09-03', 4),
  (214, 20, '2024-10-01', 1), (215, 20, '2024-10-02', 1), (216, 20, '2024-10-03', 1),
  (301, 30, '2025-01-01', 1), (302, 30, '2024-12-01', 1), (303, 30, '2024-12-02', 4),
  (304, 30, '2024-12-03', 1), (306, 30, '2024-12-05', 0), (310, 30, '2024-08-01', 8);
UPDATE "Post" SET "tosViolation" = true WHERE id IN (110, 211, 214, 302);
UPDATE "Post" SET unlisted = true WHERE id IN (111, 212, 215);
UPDATE "Post" SET availability = 'Private' WHERE id IN (112, 213, 216);
INSERT INTO "Image" VALUES
  (1001, 101, 0), (1002, 101, 1), (1003, 101, 2),
  (2005, 202, 2), (2009, 202, 0), (2007, 202, 1),
  (3003, 201, 1), (3007, 201, 0);
`;

// Other storylines the seed and cleanup must leave alone. "Prior" already uses posts 107, 108,
// 208 and 304; the two decoys each share one half of the demo's (owner, title) key.
const OTHER_STORYLINES = `
INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
  (901, 30, 'Prior', 4, now()), (902, 10, 'Other', 1, now()), (903, 20, 'The Patch', 1, now());
SELECT setval(pg_get_serial_sequence('"Storyline"', 'id'), 1000);
INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth) VALUES
  (901, 107, 10, 0), (901, 208, 20, 1), (901, 108, 10, 1), (901, 304, 30, 1);
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

async function prepare(c, url) {
  await assertThrowaway(c, url);
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
  [1, 202, 'CivChan', 'canon', false, 101],
  [2, 103, 'CivBot', 'canon', false, 202],
  [3, 201, 'CivChan', 'canon', false, 103],
];
const CANON_END = [4, 102, 'CivBot', 'canon', false, 201];
const ENDORSED_END = [4, 203, 'CivChan', 'endorsed', false, 201];
const COMMUNITY_END = [4, 301, 'Someone', 'community', false, 201];
const ABOVE_CEILING_END = [4, 206, 'CivChan', 'endorsed', true, 201];
const DEMO = [...MAIN, CANON_END, ENDORSED_END, ABOVE_CEILING_END];

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
    await prepare(c, url);
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
  await prepare(c, DEV_URL);
  const cluster = (await c.query(`SELECT current_setting('cluster_name') AS n`)).rows[0].n;
  assert.ok(cluster.endsWith('-dev'), `DEV_URL must be a *-dev cluster (got "${cluster}")`);
  const posts = await digest(c, 'Post');
  const images = await digest(c, 'Image');
  const others = await otherStorylines(c);

  /** Runs a check that expects the seed to refuse, from and back to a clean state. */
  async function refusal(name, setup, teardown, sql, pattern) {
    await check(name, async () => {
      await c.query(cleanupSql);
      await c.query(setup);
      try {
        await assert.rejects(c.query(sql), pattern);
        assert.equal(await demoChapters(c), 0);
      } finally {
        await c.query(teardown);
        await c.query(cleanupSql);
      }
    });
  }

  let rows = [];
  await check('seed builds the demo storyline', async () => {
    rows = (await c.query(seedSql)).at(-1).rows;
    assert.deepEqual(shape(rows), DEMO);
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
    const printed = rows.map((r) => [r.postId, r.firstImageId, r.lastImageId]);
    assert.deepEqual(printed.slice(0, 4), [
      [101, 1001, 1003],
      [202, 2009, 2005],
      [103, null, null],
      [201, 3007, 3003],
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
      4
    );
    assert.equal(await count(c, `SELECT count(*)::int AS n FROM "StorylineChapterEdge"`), 0);
    assert.equal(await count(c, `SELECT count(*)::int AS n FROM "StorylineCollaborator"`), 0);
    assert.equal(await digest(c, 'Post'), posts);
  });

  await check('a named third account adds a community continuation', async () => {
    try {
      const withCommunity = (await c.query(seedWithCommunity('Someone'))).at(-1).rows;
      assert.deepEqual(shape(withCommunity), [
        ...MAIN,
        CANON_END,
        ENDORSED_END,
        COMMUNITY_END,
        ABOVE_CEILING_END,
      ]);
    } finally {
      await c.query(cleanupSql);
    }
  });

  await refusal(
    'seed refuses a named third account with no usable post',
    `UPDATE "Post" SET "publishedAt" = NULL WHERE id = 301`,
    `UPDATE "Post" SET "publishedAt" = '2025-01-01' WHERE id = 301`,
    seedWithCommunity('Someone'),
    /has no post at or under the ceiling/
  );
  await refusal(
    'seed refuses a named third account that does not exist',
    `SELECT 1`,
    `SELECT 1`,
    seedWithCommunity('Nobody'),
    /account Nobody not found/
  );
  await refusal(
    'seed refuses a deleted owner account',
    `UPDATE "User" SET "deletedAt" = now() WHERE id = 10`,
    `UPDATE "User" SET "deletedAt" = NULL WHERE id = 10`,
    seedSql,
    /not found/
  );

  // Unpublished and scheduled posts sort last, so they are only reached when an account runs
  // short of usable ones.
  await refusal(
    "seed refuses rather than use the owner's unpublished or scheduled posts",
    `UPDATE "Post" SET "publishedAt" = NULL WHERE id = 102`,
    `UPDATE "Post" SET "publishedAt" = '2025-01-03' WHERE id = 102`,
    seedSql,
    /need 3 posts/
  );
  await refusal(
    "seed refuses rather than use the collaborator's unpublished post",
    `UPDATE "Post" SET "publishedAt" = NULL WHERE id = 203`,
    `UPDATE "Post" SET "publishedAt" = '2025-01-03' WHERE id = 203`,
    seedSql,
    /need 3 posts/
  );
  await refusal(
    'seed refuses when the only posts above the ceiling are unusable',
    `UPDATE "Post" SET "publishedAt" = NULL WHERE id IN (104, 204, 206)`,
    `UPDATE "Post" SET "publishedAt" = v.d::timestamp
       FROM (VALUES (104, '2024-12-30'), (204, '2025-01-04'), (206, '2024-12-29')) v(id, d)
      WHERE "Post".id = v.id`,
    seedSql,
    /no post above the ceiling/
  );

  await check('seed after cleanup rebuilds the same storyline', async () => {
    assert.equal(await digest(c, 'Post'), posts);
    assert.equal(await demoChapters(c), 0);
    assert.deepEqual(shape((await c.query(seedSql)).at(-1).rows), DEMO);
  });
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
