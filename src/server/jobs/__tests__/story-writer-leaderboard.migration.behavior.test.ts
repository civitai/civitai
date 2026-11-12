import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20261112170000_story_writer_leaderboard/migration.sql'
  ),
  'utf8'
);

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
  CREATE TABLE "Tag" (id int PRIMARY KEY, name text NOT NULL);
  CREATE TABLE "TagsOnTags" ("fromTagId" int NOT NULL, "toTagId" int NOT NULL);
  CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp);
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, "publishedAt" timestamp,
    nsfw boolean NOT NULL DEFAULT false
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
type ArticleFixture = {
  id: number;
  userId: number;
  tag: number;
  daysAgo?: number;
  nsfw?: boolean;
  views?: number;
  likes?: number;
  bookmarks?: number;
};

async function seedArticles(pg: PGlite, articles: ArticleFixture[]) {
  for (const a of articles) {
    await pg.query(`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [a.userId]);
    await pg.query(
      `INSERT INTO "Article" VALUES ($1, $2, 'Published', now() - make_interval(days => $3), $4)`,
      [a.id, a.userId, a.daysAgo ?? 1, a.nsfw ?? false]
    );
    await pg.query(`INSERT INTO "TagsOnArticle" VALUES ($1, $2)`, [a.id, a.tag]);
    await pg.query(
      `INSERT INTO "ArticleMetric" ("articleId", timeframe, "viewCount", "likeCount", "collectedCount")
       VALUES ($1, 'AllTime', $2, $3, $4)`,
      [a.id, a.views ?? 0, a.likes ?? 0, a.bookmarks ?? 0]
    );
  }
}

/** The board's query as prepare-leaderboard's default path runs it (prepare-leaderboard.ts:330). */
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
    await seedArticles(db.pg, [
      { id: 1, userId: 10, tag: STORY, views: 100, likes: 49 },
      { id: 2, userId: 11, tag: STORY, bookmarks: 100 },
      { id: 3, userId: 12, tag: NEWS, likes: 10000, bookmarks: 10000 },
      { id: 4, userId: 13, tag: STORY, nsfw: true, likes: 10000 },
      { id: 5, userId: 14, tag: STORY, daysAgo: 40, likes: 10000 },
    ]);
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

  it('ranks only recent, non-nsfw story articles, with bookmarks weighted 4', async () => {
    const rows = await standings(db.pg);
    // (sqrt(100)*1 + sqrt(49)*7 + sqrt(1)*4) * 100; the greatest(..., 1) floor makes empty terms 1.
    expect(rows.map((r) => [r.userId, r.score])).toEqual([
      [10, 6300],
      [11, 4800],
    ]);
    expect(rows[1].metrics).toEqual({ viewCount: 0, bookmark: 100, reactionCount: 0 });
  });

  it('awards four Storyteller badges at 1, 3, 10 and 25 with the writer badge art as placeholder', async () => {
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
        data: { url: 'diamond' },
      },
      {
        name: 'Gold Storyteller',
        position: 3,
        type: 'Badge',
        source: 'Trophy',
        permanentUnlock: false,
        data: { url: 'gold' },
      },
      {
        name: 'Silver Storyteller',
        position: 10,
        type: 'Badge',
        source: 'Trophy',
        permanentUnlock: false,
        data: { url: 'silver' },
      },
      {
        name: 'Bronze Storyteller',
        position: 25,
        type: 'Badge',
        source: 'Trophy',
        permanentUnlock: false,
        data: { url: 'bronze' },
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
