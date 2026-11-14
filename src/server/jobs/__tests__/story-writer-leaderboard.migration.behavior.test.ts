import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ARTICLE_CATEGORY_BACKFILL_SQL } from '~/server/services/text-scan/article-category-backfill-query';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );
const MIGRATION = migration('20261112170000_story_writer_leaderboard');
const SWITCH = migration('20271114120000_story_writer_system_category');

const SCHEMA = `
  CREATE TYPE "DomainColor" AS ENUM ('green', 'blue', 'red', 'all');
  CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'NamePlate');
  CREATE TYPE "CosmeticSource" AS ENUM ('Trophy', 'Purchase');
  CREATE TABLE "Leaderboard" (
    id text PRIMARY KEY, index int NOT NULL, title text NOT NULL, description text NOT NULL,
    "scoringDescription" text NOT NULL, query text NOT NULL, active boolean NOT NULL,
    public boolean NOT NULL, domain "DomainColor"[] NOT NULL DEFAULT '{all}'
  );
  CREATE TABLE "Cosmetic" (
    id serial PRIMARY KEY, name text NOT NULL, description text, type "CosmeticType" NOT NULL,
    source "CosmeticSource" NOT NULL, "permanentUnlock" boolean NOT NULL, data jsonb NOT NULL,
    "leaderboardId" text, "leaderboardPosition" int
  );
  CREATE TABLE "Tag" (id int PRIMARY KEY, name text NOT NULL, "adminOnly" boolean NOT NULL DEFAULT false);
  CREATE TABLE "TagsOnTags" ("fromTagId" int NOT NULL, "toTagId" int NOT NULL);
  CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp, "bannedAt" timestamp);
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, "publishedAt" timestamp,
    nsfw boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL, ingestion text NOT NULL,
    "tosViolation" boolean NOT NULL, unlisted boolean NOT NULL, availability text NOT NULL,
    "systemCategoryId" int
  );
  CREATE TABLE "TagsOnArticle" ("articleId" int NOT NULL, "tagId" int NOT NULL);
  CREATE TABLE "ArticleMetric" (
    "articleId" int NOT NULL, timeframe text NOT NULL, "viewCount" int NOT NULL DEFAULT 0,
    "likeCount" int NOT NULL DEFAULT 0, "heartCount" int NOT NULL DEFAULT 0,
    "laughCount" int NOT NULL DEFAULT 0, "cryCount" int NOT NULL DEFAULT 0,
    "collectedCount" int NOT NULL DEFAULT 0
  );
`;

const WRITER_BOARD = `
  INSERT INTO "Leaderboard" VALUES
    ('writer', 16, 'Writers', 'Writer board', 'Score', 'SELECT 1', true, true, '{all}');
  INSERT INTO "Cosmetic" (name, type, source, "permanentUnlock", data, "leaderboardId", "leaderboardPosition") VALUES
    ('Diamond Writer', 'Badge', 'Trophy', false, '{"url":"diamond"}', 'writer', 1),
    ('Gold Writer', 'Badge', 'Trophy', false, '{"url":"gold"}', 'writer', 3),
    ('Silver Writer', 'Badge', 'Trophy', false, '{"url":"silver"}', 'writer', 10),
    ('Bronze Writer', 'Badge', 'Trophy', false, '{"url":"bronze"}', 'writer', 100);
`;

const CATEGORIES = `
  INSERT INTO "Tag" VALUES (1, 'article category'), (2, 'story'), (3, 'news');
  INSERT INTO "TagsOnTags" VALUES (1, 2), (1, 3);
`;

const STORY = 2;
const NEWS = 3;
const HUGE = { views: 1_000_000, likes: 10000, bookmarks: 10000 };
type ArticleFixture = {
  id: number;
  userId: number;
  tag: number;
  /** The category call's answer; defaults to the author's tag. */
  systemCategory?: number | null;
  daysAgo?: number;
  status?: string;
  nsfwLevel?: number;
  ingestion?: string;
  tosViolation?: boolean;
  unlisted?: boolean;
  availability?: string;
  userDeleted?: boolean;
  userBanned?: boolean;
  views?: number;
  likes?: number;
  bookmarks?: number;
};

async function seedArticles(pg: PGlite, articles: ArticleFixture[]) {
  for (const a of articles) {
    await pg.query(
      `INSERT INTO "User" VALUES ($1, CASE WHEN $2 THEN now() END, CASE WHEN $3 THEN now() END)
       ON CONFLICT DO NOTHING`,
      [a.userId, a.userDeleted ?? false, a.userBanned ?? false]
    );
    await pg.query(
      `INSERT INTO "Article" (id, "userId", status, "publishedAt", "nsfwLevel", ingestion, "tosViolation", unlisted, availability, "systemCategoryId")
       VALUES ($1, $2, $3, now() - make_interval(days => $4), $5, $6, $7, $8, $9, $10)`,
      [
        a.id,
        a.userId,
        a.status ?? 'Published',
        a.daysAgo ?? 1,
        a.nsfwLevel ?? 1,
        a.ingestion ?? 'Scanned',
        a.tosViolation ?? false,
        a.unlisted ?? false,
        a.availability ?? 'Public',
        a.systemCategory === undefined ? a.tag : a.systemCategory,
      ]
    );
    await pg.query(`INSERT INTO "TagsOnArticle" VALUES ($1, $2)`, [a.id, a.tag]);
    await pg.query(
      `INSERT INTO "ArticleMetric" ("articleId", timeframe, "viewCount", "likeCount", "collectedCount")
       VALUES ($1, 'AllTime', $2, $3, $4)`,
      [a.id, a.views ?? 0, a.likes ?? 0, a.bookmarks ?? 0]
    );
  }
}

/** Two story articles that count, then one fixture per filter, each of which would top the board. */
const ELIGIBILITY: ArticleFixture[] = [
  { id: 1, userId: 10, tag: STORY, views: 100, likes: 49 },
  { id: 2, userId: 11, tag: STORY, bookmarks: 100, nsfwLevel: 2 },
  // Each of these would top the board if it counted.
  { id: 3, userId: 12, tag: NEWS, ...HUGE },
  { id: 4, userId: 13, tag: STORY, nsfwLevel: 4, ...HUGE },
  { id: 5, userId: 14, tag: STORY, daysAgo: 40, ...HUGE },
  { id: 6, userId: 15, tag: STORY, nsfwLevel: 0, ...HUGE },
  { id: 7, userId: 16, tag: STORY, status: 'Draft', ...HUGE },
  { id: 8, userId: 17, tag: STORY, userDeleted: true, ...HUGE },
  { id: 9, userId: 18, tag: STORY, userBanned: true, ...HUGE },
  { id: 10, userId: -1, tag: STORY, ...HUGE },
  { id: 11, userId: 19, tag: STORY, ingestion: 'Pending', ...HUGE },
  { id: 12, userId: 20, tag: STORY, tosViolation: true, ...HUGE },
  { id: 13, userId: 21, tag: STORY, unlisted: true, ...HUGE },
  { id: 14, userId: 22, tag: STORY, availability: 'Private', ...HUGE },
  { id: 15, userId: 23, tag: STORY, nsfwLevel: 32, ...HUGE },
];

/** The board's query as prepare-leaderboard's defaultLeadboardPopulation wraps it. */
async function standings(pg: PGlite) {
  const {
    rows: [{ query }],
  } = await pg.query<{ query: string }>(
    `SELECT query FROM "Leaderboard" WHERE id = 'story-writer'`
  );
  expect(query.includes('WITH ')).toBe(false);
  const { rows } = await pg.query<{
    userId: number;
    score: number;
    metrics: Record<string, number>;
  }>(
    `WITH scores AS (${query}) SELECT "userId", ROUND(score)::int AS score, metrics FROM scores ORDER BY score DESC`
  );
  return rows;
}

describe('story-writer leaderboard migration', () => {
  const db = { pg: null as unknown as PGlite };

  beforeAll(async () => {
    db.pg = new PGlite();
    await db.pg.exec(SCHEMA + WRITER_BOARD + CATEGORIES);
    await seedArticles(db.pg, ELIGIBILITY);
    await db.pg.exec(MIGRATION);
  });

  afterAll(async () => {
    await db.pg.close();
  });

  it('adds a board that shows wherever the writer board shows, in the slot after it', async () => {
    const { rows } = await db.pg.query(
      `SELECT s.index - w.index AS slot, s.active = w.active AND s.public = w.public AND s.domain = w.domain AS same_display,
              s.active, s.public, s.title
       FROM "Leaderboard" s, "Leaderboard" w WHERE s.id = 'story-writer' AND w.id = 'writer'`
    );
    expect(rows).toEqual([
      { slot: 1, same_display: true, active: true, public: true, title: 'Story Writers' },
    ]);
  });

  it('ranks only recent, public, PG/PG-13 story articles by live users, with bookmarks weighted 4', async () => {
    const rows = await standings(db.pg);
    // (sqrt(100)*1 + sqrt(49)*7 + sqrt(1)*4) * 100; the greatest(..., 1) floor makes empty terms 1.
    expect(rows.map((r) => [r.userId, r.score])).toEqual([
      [10, 6300],
      [11, 4800],
    ]);
    expect(rows[1].metrics).toEqual({ viewCount: 0, bookmark: 100, reactionCount: 0 });
  });

  it('awards four Storyteller badges at 1, 3, 10 and 25 each with its own Storyteller art', async () => {
    const { rows } = await db.pg.query(
      `SELECT name, "leaderboardPosition" AS position, type, source, "permanentUnlock", data
       FROM "Cosmetic" WHERE "leaderboardId" = 'story-writer' ORDER BY "leaderboardPosition"`
    );
    expect(rows).toEqual([
      {
        name: 'Diamond Storyteller',
        position: 1,
        type: 'Badge',
        source: 'Trophy',
        permanentUnlock: false,
        data: { url: '500eaff2-efff-4fcd-9fcb-a96c4eb3c7dc' },
      },
      {
        name: 'Gold Storyteller',
        position: 3,
        type: 'Badge',
        source: 'Trophy',
        permanentUnlock: false,
        data: { url: 'ed20a778-69a3-4e00-88be-712774848170' },
      },
      {
        name: 'Silver Storyteller',
        position: 10,
        type: 'Badge',
        source: 'Trophy',
        permanentUnlock: false,
        data: { url: 'ffa5ca46-b306-4602-9640-4c6f2d84913c' },
      },
      {
        name: 'Bronze Storyteller',
        position: 25,
        type: 'Badge',
        source: 'Trophy',
        permanentUnlock: false,
        data: { url: 'bf566745-77e3-4423-b043-75209ce6fc60' },
      },
    ]);
  });

  it('is idempotent: a re-run adds no second board or badge set', async () => {
    await db.pg.exec(MIGRATION);
    const { rows } = await db.pg.query<{ boards: number; badges: number }>(
      `SELECT (SELECT count(*)::int FROM "Leaderboard" WHERE id = 'story-writer') AS boards,
              (SELECT count(*)::int FROM "Cosmetic" WHERE "leaderboardId" = 'story-writer') AS badges`
    );
    expect(rows).toEqual([{ boards: 1, badges: 4 }]);
  });
});

describe('story-writer leaderboard migration preconditions', () => {
  it('refuses to add a board when there is no story article category', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(SCHEMA + WRITER_BOARD + `INSERT INTO "Tag" VALUES (1, 'article category');`);
      await expect(pg.exec(MIGRATION)).rejects.toThrow(/no 'story' tag/);
      await pg.exec('ROLLBACK');
      const { rows } = await pg.query(`SELECT id FROM "Leaderboard" WHERE id = 'story-writer'`);
      expect(rows).toEqual([]);
    } finally {
      await pg.close();
    }
  });
});

const USER_TAGGED_ONLY = { id: 16, userId: 24, tag: STORY, systemCategory: NEWS, ...HUGE };
// (sqrt(400)*1 + 1*7 + 1*4) * 100
const SYSTEM_STORY_ONLY = { id: 17, userId: 25, tag: NEWS, systemCategory: STORY, views: 400 };

describe('story-writer system-category switch', () => {
  const db = { pg: null as unknown as PGlite };

  beforeAll(async () => {
    db.pg = new PGlite();
    await db.pg.exec(SCHEMA + WRITER_BOARD + CATEGORIES);
    await seedArticles(db.pg, [...ELIGIBILITY, USER_TAGGED_ONLY, SYSTEM_STORY_ONLY]);
    await db.pg.exec(MIGRATION);
  });

  afterAll(async () => {
    await db.pg.close();
  });

  it('before it, the board follows the author tag: a non-story tagged story tops it, a story tagged otherwise is missed', async () => {
    const rows = await standings(db.pg);
    expect(rows.map((r) => r.userId)).toEqual([24, 10, 11]);
  });

  it('after it, only the category call decides, and every other filter and weight still holds', async () => {
    await db.pg.exec(SWITCH);
    const rows = await standings(db.pg);
    expect(rows.map((r) => [r.userId, r.score])).toEqual([
      [10, 6300],
      [11, 4800],
      [25, 3100],
    ]);
  });

  it('is idempotent: a re-run leaves the switched query as it is', async () => {
    const read = async () =>
      (
        await db.pg.query<{ query: string }>(
          `SELECT query FROM "Leaderboard" WHERE id = 'story-writer'`
        )
      ).rows[0].query;
    const before = await read();
    await db.pg.exec(SWITCH);
    expect(await read()).toBe(before);
    expect(before).not.toContain('TagsOnArticle');
  });
});

describe('story-writer system-category switch preconditions', () => {
  async function refuses(setup: string, error: RegExp) {
    const pg = new PGlite();
    const boards = async () =>
      (await pg.query(`SELECT * FROM "Leaderboard" WHERE id = 'story-writer'`)).rows;
    try {
      await pg.exec(SCHEMA + WRITER_BOARD + CATEGORIES);
      await pg.exec(MIGRATION);
      await pg.exec(setup);
      const before = await boards();
      await expect(pg.exec(SWITCH)).rejects.toThrow(error);
      await pg.exec('ROLLBACK');
      expect(await boards()).toEqual(before);
    } finally {
      await pg.close();
    }
  }

  it('refuses when there is no story article category', () =>
    refuses(`DELETE FROM "TagsOnTags" WHERE "toTagId" = ${STORY};`, /no 'story' tag/));

  it('refuses when the story category is adminOnly, which the category call is never offered', () =>
    refuses(`UPDATE "Tag" SET "adminOnly" = true WHERE id = ${STORY};`, /adminOnly/));

  it('refuses when the board row is missing', () =>
    refuses(`DELETE FROM "Leaderboard" WHERE id = 'story-writer';`, /row not found/));

  it('refuses, changing nothing, when the query was edited since it was added', () =>
    refuses(
      `UPDATE "Leaderboard" SET query = 'SELECT 2' WHERE id = 'story-writer';`,
      /was edited/
    ));
});

describe('article category backfill selection', () => {
  const db = { pg: null as unknown as PGlite };
  const select = async (afterId: number, limit: number) =>
    (await db.pg.query<{ id: number }>(ARTICLE_CATEGORY_BACKFILL_SQL, [afterId, limit])).rows.map(
      (r) => r.id
    );

  beforeAll(async () => {
    db.pg = new PGlite();
    await db.pg.exec(SCHEMA + CATEGORIES);
    await seedArticles(db.pg, [
      ...ELIGIBILITY.map((a) => ({ ...a, systemCategory: null })),
      { id: 18, userId: 26, tag: STORY, systemCategory: NEWS },
      { id: 19, userId: 27, tag: NEWS, systemCategory: null },
    ]);
  });

  afterAll(async () => {
    await db.pg.close();
  });

  it('selects unclassified articles the board could score, whatever their author tag, paged by id', async () => {
    expect(await select(0, 100)).toEqual([1, 2, 3, 19]);
    expect(await select(0, 2)).toEqual([1, 2]);
    expect(await select(2, 2)).toEqual([3, 19]);
  });

  it('selects nothing once those articles have a category', async () => {
    await db.pg.query(`UPDATE "Article" SET "systemCategoryId" = ${NEWS} WHERE id = ANY($1)`, [
      await select(0, 100),
    ]);
    expect(await select(0, 100)).toEqual([]);
  });
});
