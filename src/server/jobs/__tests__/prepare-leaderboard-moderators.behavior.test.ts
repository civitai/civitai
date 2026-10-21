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

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  clickhouseLeaderboardPopulation,
  leaderboardJobs,
  populateLeaderboard,
} from '../prepare-leaderboard';

const PLAIN = 1;
const MODERATOR = 2;
const FLAGGED = 3;
const PLAIN_LOW = 4;

const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);

const base = { jobContext: { on: vi.fn() } as never, addDays: 0, excludedUserIds: [] };

async function board(id: string) {
  const { rows } = await q(
    `SELECT "userId", position::int FROM "LeaderboardResult" WHERE "leaderboardId" = $1 ORDER BY position`,
    [id]
  );
  return rows as { userId: number; position: number }[];
}

async function seedScores() {
  await q(`INSERT INTO "Score" ("userId", score) VALUES ($1, 40), ($2, 30), ($3, 20), ($4, 10)`, [
    MODERATOR,
    FLAGGED,
    PLAIN,
    PLAIN_LOW,
  ]);
}

const pgBoard = (id: string) =>
  populateLeaderboard(
    {
      ...base,
      id,
      includesCTE: true,
      query: `WITH scores AS (SELECT "userId", score, '{}'::jsonb metrics FROM "Score")`,
    },
    async () => [0, 1]
  );

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE FUNCTION iif(condition boolean, true_result anyelement, false_result anyelement)
      RETURNS anyelement LANGUAGE sql IMMUTABLE
      AS 'SELECT CASE WHEN condition THEN true_result ELSE false_result END';
    -- "isModerator" is nullable in prod.
    CREATE TABLE "User" (
      id INT PRIMARY KEY, "isModerator" BOOLEAN DEFAULT false,
      "excludeFromLeaderboards" BOOLEAN NOT NULL DEFAULT false,
      "deletedAt" TIMESTAMP, "bannedAt" TIMESTAMP, "mutedAt" TIMESTAMP
    );
    CREATE TABLE "Leaderboard" (id TEXT PRIMARY KEY, public BOOLEAN NOT NULL);
    CREATE TABLE "LeaderboardResult" (
      "leaderboardId" TEXT, date DATE, "userId" INT, score INT, metrics JSONB, position INT
    );
    CREATE TABLE "Score" ("userId" INT, score INT);
    INSERT INTO "User" (id, "isModerator", "excludeFromLeaderboards") VALUES
      (${PLAIN}, false, false), (${MODERATOR}, true, false), (${FLAGGED}, false, true), (${PLAIN_LOW}, NULL, false);
    INSERT INTO "Leaderboard" (id, public) VALUES ('public-board', true), ('mod-only-board', false);
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await q(`TRUNCATE "LeaderboardResult", "Score"`);
  await seedScores();
});

describe('moderators are kept off public leaderboards without the exclusion flag', () => {
  it('Postgres boards: a public board ranks neither the moderator nor the flagged account', async () => {
    await pgBoard('public-board');

    expect(await board('public-board')).toEqual([
      { userId: PLAIN, position: 1 },
      { userId: PLAIN_LOW, position: 2 },
    ]);
  });

  // The live 'writer' board is this shape: a bare SELECT with no CTE, wrapped by the job.
  it("Postgres boards without a CTE ('writer'): the moderator is not ranked", async () => {
    await q(
      `INSERT INTO "Leaderboard" (id, public) VALUES ('writer', true) ON CONFLICT DO NOTHING`
    );

    await populateLeaderboard(
      {
        ...base,
        id: 'writer',
        includesCTE: false,
        query: `SELECT "userId", score, '{}'::jsonb metrics FROM "Score"`,
      },
      async () => [0, 1]
    );

    expect((await board('writer')).map((r) => r.userId)).toEqual([PLAIN, PLAIN_LOW]);
  });

  it('Postgres boards: a non-public board still ranks the moderator and the flagged account', async () => {
    await pgBoard('mod-only-board');

    expect((await board('mod-only-board')).map((r) => r.userId)).toEqual([
      MODERATOR,
      FLAGGED,
      PLAIN,
      PLAIN_LOW,
    ]);
  });

  it('image-score boards: neither the moderator nor the flagged account is ranked', async () => {
    await populateLeaderboard(
      {
        ...base,
        id: 'images',
        includesCTE: true,
        query: `WITH image_scores AS (
          SELECT "userId", score, '{}'::jsonb metrics FROM "Score" WHERE $1::int <= $2::int
        )`,
      },
      async () => [0, 1]
    );

    expect(await board('images')).toEqual([
      { userId: PLAIN, position: 1 },
      { userId: PLAIN_LOW, position: 2 },
    ]);
  });

  it('ClickHouse boards: neither the moderator nor the flagged account is ranked', async () => {
    clickhouse.$query.mockResolvedValue(
      (await q(`SELECT "userId", score, '{}' metrics FROM "Score" ORDER BY score DESC`)).rows
    );

    await clickhouseLeaderboardPopulation({
      ...base,
      id: 'generators',
      includesCTE: true,
      query: 'WITH clickhouse_x AS (SELECT 1) SELECT 1',
    });

    expect((await board('generators')).map((r) => r.userId)).toEqual([PLAIN, PLAIN_LOW]);
  });

  it('Legends board: drops the moderator from public boards, keeps them on non-public ones', async () => {
    await q(`
      INSERT INTO "LeaderboardResult" ("leaderboardId", date, "userId", score, position) VALUES
        ('public-board', current_date - 1, ${MODERATOR}, 40, 1),
        ('public-board', current_date - 1, ${PLAIN}, 30, 2),
        ('mod-only-board', current_date - 1, ${MODERATOR}, 40, 1)
    `);
    const job = leaderboardJobs.find((j) => j.name === 'prepare-leaderboard')!;

    await job.run({} as never);

    const legendsInsert = dbMock.dbWrite.$executeRaw.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('INSERT INTO "LegendsBoardResult"')
    );
    if (!legendsInsert) throw new Error('Legends board was not written');
    const rows = JSON.parse(legendsInsert[1] as string) as {
      userId: number;
      leaderboardId: string;
    }[];
    expect(rows.map((r) => [r.leaderboardId, r.userId]).sort()).toEqual([
      ['mod-only-board', MODERATOR],
      ['public-board', PLAIN],
    ]);
  });
});
