import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const clickhouse = vi.hoisted(() => ({ $query: vi.fn() }));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse }));
vi.mock('~/server/db/pgDb', () => {
  const query = async (sql: string, params?: unknown[]) => holder.db.query(sql, params);
  const cancellableQuery = async (sql: string) => ({
    result: async () => (await holder.db.query(sql)).rows,
    cancel: async () => undefined,
  });
  return {
    pgDbRead: { query },
    pgDbReadLong: { query, cancellableQuery },
    pgDbWrite: { query, cancellableQuery },
  };
});
vi.mock('~/server/jobs/apply-discord-roles', () => ({ applyDiscordLeaderboardRoles: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: vi.fn(async () => []),
}));
vi.mock('~/server/services/leaderboard.service', () => ({
  getUnpopulatedLeaderboards: vi.fn(),
  isLeaderboardPopulated: vi.fn(),
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn({ on: vi.fn() }),
  }),
  getJobDate: vi.fn(async () => [new Date(0), vi.fn()]),
}));

import { populateLeaderboard } from '../prepare-leaderboard';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261022170000_writer_leaderboards/migration.sql'
);

const STORYTELLER = 10;
const OLD_HIT = 20;
const RELEASE_NOTES = 30;
const MUSER = 31;
const NEWCOMER = 40;
const NEWCOMER_FEW_READERS = 41;
const DORMANT_GUIDE = 50;
const READERS = Array.from({ length: 40 }, (_, i) => 1000 + i);

type Row = { userId: number; position: number; score: number; metrics: Record<string, number> };

const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);

async function run(id: string, excludedUserIds: number[] = []) {
  const { rows } = await q(`SELECT query FROM "Leaderboard" WHERE id = $1`, [id]);
  const [{ query }] = rows as { query: string }[];
  await populateLeaderboard(
    {
      jobContext: { on: vi.fn() } as never,
      id,
      query,
      includesCTE: true,
      addDays: 0,
      excludedUserIds,
    },
    async () => [0, 1]
  );
  const result = await q(
    `SELECT "userId", position::int, score, metrics FROM "LeaderboardResult" WHERE "leaderboardId" = $1 ORDER BY position`,
    [id]
  );
  return result.rows as Row[];
}

const byUser = (rows: Row[], userId: number) => rows.find((r) => r.userId === userId);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (
      id INT PRIMARY KEY, "isModerator" BOOLEAN DEFAULT false,
      "excludeFromLeaderboards" BOOLEAN NOT NULL DEFAULT false,
      "deletedAt" TIMESTAMP, "bannedAt" TIMESTAMP, "mutedAt" TIMESTAMP, "leaderboardShowcase" TEXT
    );
    CREATE TABLE "Leaderboard" (
      id TEXT PRIMARY KEY, index INT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      "scoringDescription" TEXT NOT NULL, query TEXT NOT NULL, active BOOLEAN NOT NULL, public BOOLEAN NOT NULL
    );
    CREATE TABLE "LeaderboardResult" (
      "leaderboardId" TEXT REFERENCES "Leaderboard" (id) ON DELETE CASCADE, date DATE, "userId" INT,
      score INT, metrics JSONB, position INT
    );
    CREATE TABLE "UserRank" (
      "userId" INT PRIMARY KEY, "leaderboardRank" INT, "leaderboardId" TEXT, "leaderboardTitle" TEXT,
      "leaderboardCosmetic" TEXT
    );
    CREATE TABLE "LegendsBoardResult" ("userId" INT, "leaderboardId" TEXT, score INT, metrics JSONB, position INT);
    CREATE TABLE "KeyValue" (key TEXT PRIMARY KEY, value JSONB);
    CREATE TABLE "Cosmetic" (id SERIAL PRIMARY KEY, "leaderboardId" TEXT, "leaderboardPosition" INT, data JSONB);
    CREATE TABLE "Tag" (id INT PRIMARY KEY, name TEXT NOT NULL, "isCategory" BOOLEAN NOT NULL);
    CREATE TABLE "Article" (
      id INT PRIMARY KEY, "userId" INT NOT NULL, status TEXT NOT NULL, availability TEXT NOT NULL,
      unlisted BOOLEAN NOT NULL DEFAULT false, "tosViolation" BOOLEAN NOT NULL DEFAULT false,
      "publishedAt" TIMESTAMP
    );
    CREATE TABLE "TagsOnArticle" ("articleId" INT, "tagId" INT);
    CREATE TABLE "ArticleMetric" (
      "articleId" INT, timeframe TEXT, "likeCount" INT, "heartCount" INT, "laughCount" INT,
      "cryCount" INT, "commentCount" INT, "viewCount" INT, "collectedCount" INT
    );
    CREATE TABLE "ArticleReaction" (
      id SERIAL, "articleId" INT, "userId" INT, reaction TEXT, "createdAt" TIMESTAMP
    );

    INSERT INTO "Leaderboard" VALUES ('writer', 7, 'Writers', '', '', 'SELECT 1', true, true);
    INSERT INTO "Tag" VALUES (1, 'story', true), (2, 'announcement', true), (3, 'generation guide', true),
      (4, 'musing', true), (5, 'elf', false);
    INSERT INTO "User" (id) SELECT unnest(ARRAY[
      ${STORYTELLER}, ${OLD_HIT}, ${RELEASE_NOTES}, ${MUSER}, ${NEWCOMER}, ${NEWCOMER_FEW_READERS}, ${DORMANT_GUIDE}
    ]);

    INSERT INTO "Article" SELECT 100 + g, ${STORYTELLER}, 'Published', 'Public', false, false,
      now() - g * interval '7 days' FROM generate_series(0, 7) g;
    INSERT INTO "TagsOnArticle" SELECT 100 + g, t FROM generate_series(0, 7) g, unnest(ARRAY[1, 5]) t;

    INSERT INTO "Article" VALUES (200, ${OLD_HIT}, 'Published', 'Public', false, false, now() - interval '300 days'),
      (201, ${OLD_HIT}, 'Published', 'Public', false, false, now() - interval '20 days');
    INSERT INTO "TagsOnArticle" VALUES (200, 3), (201, 3);

    -- Same age and metrics for two users; one tagged announcement, one a musing. Plus a draft and an unlisted one.
    INSERT INTO "Article" VALUES (300, ${RELEASE_NOTES}, 'Published', 'Public', false, false, now() - interval '5 days'),
      (301, ${RELEASE_NOTES}, 'Draft', 'Public', false, false, NULL),
      (302, ${RELEASE_NOTES}, 'Published', 'Public', true, false, now() - interval '5 days'),
      (310, ${MUSER}, 'Published', 'Public', false, false, now() - interval '5 days');
    INSERT INTO "TagsOnArticle" VALUES (300, 2), (301, 2), (302, 2), (310, 4);

    INSERT INTO "Article" VALUES (400, ${NEWCOMER}, 'Published', 'Public', false, false, now() - interval '10 days'),
      (410, ${NEWCOMER_FEW_READERS}, 'Published', 'Public', false, false, now() - interval '10 days'),
      (500, ${DORMANT_GUIDE}, 'Published', 'Public', false, false, now() - interval '500 days');
    INSERT INTO "TagsOnArticle" VALUES (400, 1), (410, 1), (500, 3);

    INSERT INTO "ArticleMetric"
    SELECT id, tf, 10, 5, 1, 0, 3, 400, 4 FROM "Article", unnest(ARRAY['AllTime', 'Year']) tf;
    UPDATE "ArticleMetric" SET "viewCount" = 30000, "collectedCount" = 500, "likeCount" = 300
    WHERE "articleId" IN (200, 500);

    -- The author hearts their own chapters; they must not count as a reader.
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 100 + c, r, 'Like', now() - interval '3 days'
    FROM generate_series(0, 7) c, unnest(ARRAY[${READERS.join(',')}]) r;
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 100 + c, ${STORYTELLER}, 'Heart', now() FROM generate_series(0, 7) c;
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 400, 2000 + g, 'Like', now() FROM generate_series(0, 29) g;
    INSERT INTO "ArticleReaction" ("articleId", "userId", reaction, "createdAt")
    SELECT 410, 3000 + g, 'Like', now() FROM generate_series(0, 9) g;
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf-8'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  await q(`TRUNCATE "LeaderboardResult"`);
});

describe('writer leaderboards migration', () => {
  it('stages the four boards hidden and unpopulated, after the existing boards', async () => {
    const { rows } = await q(
      `SELECT id, index, active, public FROM "Leaderboard" WHERE id LIKE 'writer-%' ORDER BY index`
    );
    expect(rows).toEqual([
      { id: 'writer-active', index: 8, active: false, public: false },
      { id: 'writer-story', index: 9, active: false, public: false },
      { id: 'writer-guide', index: 10, active: false, public: false },
      { id: 'writer-rising', index: 11, active: false, public: false },
    ]);
  });
});

describe('Active Writers', () => {
  it('ranks a writer publishing every week above an old hit', async () => {
    const rows = await run('writer-active');
    expect(rows[0].userId).toBe(STORYTELLER);
    expect(byUser(rows, STORYTELLER)!.score).toBeGreaterThan(byUser(rows, OLD_HIT)!.score);
  });

  it('gives release notes a quarter of the points and skips drafts and unlisted articles', async () => {
    const rows = await run('writer-active');
    const notes = byUser(rows, RELEASE_NOTES)!;
    const musing = byUser(rows, MUSER)!;
    expect(notes.metrics.articles).toBe(1);
    expect(Math.abs(notes.score * 4 - musing.score)).toBeLessThanOrEqual(4);
  });

  it('leaves out articles older than a year', async () => {
    const rows = await run('writer-active');
    expect(byUser(rows, DORMANT_GUIDE)).toBeUndefined();
  });
});

describe('Storytellers', () => {
  it('counts readers who came back and weeks with a new chapter, never the author', async () => {
    const rows = await run('writer-story');
    expect(byUser(rows, STORYTELLER)!.metrics).toEqual({
      articles: 8,
      loyalReaders: 40,
      activeWeeks: 8,
    });
  });

  it('drops reactions from metric-excluded accounts', async () => {
    const all = byUser(await run('writer-story'), STORYTELLER)!;
    await q(`TRUNCATE "LeaderboardResult"`);
    const filtered = byUser(await run('writer-story', READERS), STORYTELLER)!;
    expect(filtered.metrics.loyalReaders).toBe(0);
    expect(filtered.score).toBeLessThan(all.score);
  });
});

describe('Guide Writers', () => {
  it('ranks guides of any age but needs a guide from the last year', async () => {
    const rows = await run('writer-guide');
    expect(rows[0].userId).toBe(OLD_HIT);
    expect(byUser(rows, DORMANT_GUIDE)).toBeUndefined();
  });
});

describe('Rising Writers', () => {
  it('ranks only writers whose first article is under 90 days old and who have 25 readers', async () => {
    const rows = await run('writer-rising');
    expect(byUser(rows, NEWCOMER)!.metrics).toEqual({ articles: 1, readers: 30 });
    expect(byUser(rows, NEWCOMER_FEW_READERS)).toBeUndefined();
    expect(byUser(rows, OLD_HIT)).toBeUndefined();
  });
});

// Runs last: it deletes the boards the suites above read.
describe('the rollback in the migration header', () => {
  const rollbackSql = () => {
    const lines = readFileSync(MIGRATION, 'utf-8').split('\n');
    const start = lines.indexOf('--   BEGIN;');
    const end = lines.indexOf('--   COMMIT;');
    return lines
      .slice(start, end + 1)
      .map((line) => line.replace(/^-- {3}/, ''))
      .join('\n');
  };
  const writerBoards = async () =>
    (await q(`SELECT id FROM "Leaderboard" WHERE id LIKE 'writer-%' ORDER BY id`)).rows;

  it('refuses while a badge for one of the boards exists, and changes nothing', async () => {
    await q(
      `INSERT INTO "Cosmetic" ("leaderboardId", "leaderboardPosition", data) VALUES ('writer-active', 10, '{}')`
    );
    await expect(holder.db.exec(rollbackSql())).rejects.toThrow(
      'writer board badges exist: roll back their migration first'
    );
    await q('ROLLBACK');
    expect(await writerBoards()).toHaveLength(4);
    await q(`DELETE FROM "Cosmetic"`);
  });

  it('removes what the boards produced and rebuilds their ranks from the boards that remain', async () => {
    await run('writer-active');
    await holder.db.exec(`
      INSERT INTO "LeaderboardResult" VALUES ('writer', current_date, ${STORYTELLER}, 500, '{}', 5);
      INSERT INTO "Cosmetic" ("leaderboardId", "leaderboardPosition", data) VALUES ('writer', 10, '{"url": "bronze"}');
      INSERT INTO "UserRank" VALUES (${STORYTELLER}, 1, 'writer-active', 'Active Writers', NULL),
        (${OLD_HIT}, 3, 'writer', 'Writers', NULL);
      INSERT INTO "LegendsBoardResult" VALUES (${STORYTELLER}, 'writer-story', 10, '{}', 1),
        (${OLD_HIT}, 'writer', 10, '{}', 3);
      INSERT INTO "KeyValue" VALUES ('leaderboard:populated:writer-active', '"2026-10-22"'),
        ('leaderboard:populated:writer', '"2026-10-22"');
    `);

    await holder.db.exec(rollbackSql());

    expect(await writerBoards()).toEqual([]);
    const results = await q(`SELECT DISTINCT "leaderboardId" FROM "LeaderboardResult"`);
    expect(results.rows).toEqual([{ leaderboardId: 'writer' }]);
    const ranks = await q(`SELECT * FROM "UserRank" ORDER BY "userId"`);
    expect(ranks.rows).toEqual([
      {
        userId: STORYTELLER,
        leaderboardRank: 5,
        leaderboardId: 'writer',
        leaderboardTitle: 'Writers',
        leaderboardCosmetic: 'bronze',
      },
      {
        userId: OLD_HIT,
        leaderboardRank: 3,
        leaderboardId: 'writer',
        leaderboardTitle: 'Writers',
        leaderboardCosmetic: null,
      },
    ]);
    const legends = await q(`SELECT DISTINCT "leaderboardId" FROM "LegendsBoardResult"`);
    expect(legends.rows).toEqual([{ leaderboardId: 'writer' }]);
    const keys = await q(`SELECT key FROM "KeyValue"`);
    expect(keys.rows).toEqual([{ key: 'leaderboard:populated:writer' }]);
  });
});
