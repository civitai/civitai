import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The Postgres half of the hourly scoring job, executed against an in-process Postgres running the
 * committed migration: writing a scored day, rescoring it, and every standings read built from it.
 * ClickHouse is faked; it returns the rows the score query would. The query itself is checked
 * against fixtures by scripts/check-event-score-sql.mjs, which needs a ClickHouse server.
 */

const ch = vi.hoisted(() => ({ rows: [] as object[], query: vi.fn(), insert: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { query: ch.query, insert: ch.insert },
}));

const {
  runCosmeticPlacementScoring,
  getEventStandings,
  getTeamScoreHistory,
  getCosmeticScores,
  getUserCosmeticScores,
} = await import('~/server/events/scoring/cosmetic-placement.service');

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261012120000_event_cosmetic_placement/migration.sql'
);
const db = { pg: null as unknown as PGlite };

const event = {
  name: 'scoretest',
  startDate: new Date('2026-11-11T08:00:00.000Z'),
  endDate: new Date('2026-11-26T08:00:00.000Z'),
  teams: ['Yellow', 'Blue', 'Pink', 'Green'] as const,
  scoring: {
    reactionWeight: 10,
    anonFloor: 10,
    anonRatio: 1,
    botSessionEntityLimit: 1500,
    newAccountDays: 7,
    viewerOwnerDailyCap: 50,
    finalizeAfterMs: 24 * 60 * 60 * 1000,
  },
};
const DAY1 = new Date('2026-11-12T20:00:00.000Z');
const DAY2 = new Date('2026-11-13T20:00:00.000Z');
const BANNED = 3;
const DELETED = 4;
const EXCLUDED = 5;

const row = (
  userId: number,
  cosmeticId: number,
  claimKey: string,
  team: string,
  impressions: number,
  anonImpressions: number,
  reactions: number
) => ({ userId, cosmeticId, claimKey, team, impressions, anonImpressions, reactions });

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
    CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'ContentDecoration');
    CREATE TABLE "Cosmetic" ("id" integer PRIMARY KEY, "type" "CosmeticType" NOT NULL, "data" jsonb);
    CREATE TABLE "UserCosmetic" (
      "userId" integer NOT NULL, "cosmeticId" integer NOT NULL, "claimKey" text NOT NULL,
      "equippedAt" timestamp(3), "data" jsonb, "equippedToId" integer, "equippedToType" "CosmeticEntity",
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Article" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "User" (
      "id" integer PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3),
      "excludeFromLeaderboards" boolean NOT NULL DEFAULT false
    );
    INSERT INTO "User" ("id", "bannedAt", "deletedAt", "excludeFromLeaderboards") VALUES
      (1, NULL, NULL, false), (2, NULL, NULL, false), (${BANNED}, now(), NULL, false),
      (${DELETED}, NULL, now(), false), (${EXCLUDED}, NULL, NULL, true);
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`TRUNCATE "EventCosmeticScoreDaily"`);
  vi.clearAllMocks();
  const raw = pgliteRaw(db.pg);
  for (const client of [dbMock.dbWrite, dbMock.dbRead]) {
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
  }
  // The array form only: the statements already ran when their promises were created, so this proves
  // ordering, not atomicity. A failed INSERT after the DELETE is not observable here.
  dbMock.dbWrite.$transaction.mockImplementation((async (ops: Promise<unknown>[]) =>
    Promise.all(ops)) as never);
  dbMock.dbWrite.eventCosmeticPlacement.findMany.mockResolvedValue([]);
  redisMock.redis.get.mockResolvedValue(null);
  redisMock.redis.packed.get.mockResolvedValue(null);
  ch.query.mockReset();
  ch.query.mockImplementation(async () => ({ json: async () => ch.rows }));
  ch.insert.mockReset();
  ch.insert.mockResolvedValue(undefined);
});

async function stored() {
  const res = await db.pg.query<Record<string, unknown>>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, "userId", "cosmeticId", "claimKey", team,
            impressions, "anonImpressions", reactions, points
     FROM "EventCosmeticScoreDaily" ORDER BY day, "userId", "claimKey"`
  );
  return res.rows;
}

describe('scoring a day', () => {
  it('stores each column where it belongs and computes points with the reaction weight', async () => {
    ch.rows = [row(1, 21, 'claimed', 'Yellow', 7, 3, 2)];
    await runCosmeticPlacementScoring(event, DAY1);

    expect(await stored()).toEqual([
      {
        day: '2026-11-12',
        userId: 1,
        cosmeticId: 21,
        claimKey: 'claimed',
        team: 'Yellow',
        impressions: 7,
        anonImpressions: 3,
        reactions: 2,
        points: 30,
      },
    ]);
  });

  it('replaces a day when it is rescored, never adding to it', async () => {
    ch.rows = [row(1, 21, 'claimed', 'Yellow', 7, 3, 2), row(2, 22, 'claimed', 'Blue', 5, 0, 0)];
    await runCosmeticPlacementScoring(event, DAY1);
    ch.rows = [row(1, 21, 'claimed', 'Yellow', 9, 3, 2)];
    await runCosmeticPlacementScoring(event, DAY1);

    expect((await stored()).map((r) => [r.userId, r.points])).toEqual([[1, 32]]);
  });

  it('passes each scoring parameter to the query under its own name', async () => {
    ch.rows = [];
    await runCosmeticPlacementScoring(event, DAY1);

    const { query_params, clickhouse_settings } = ch.query.mock.calls[0][0];
    expect(query_params).toEqual({
      event: 'scoretest',
      dayStart: '2026-11-12 00:00:00.000',
      dayEnd: '2026-11-12 20:00:00.000',
      eventStart: '2026-11-11 08:00:00.000',
      newAccountCutoff: '2026-11-04 08:00:00.000',
      botLimit: 1500,
      viewerCap: 50,
      anonFloor: 10,
      anonRatio: 1,
    });
    expect(clickhouse_settings).toMatchObject({ max_execution_time: 120 });
  });
});

describe('standings', () => {
  beforeEach(async () => {
    ch.rows = [
      row(1, 21, 'claimed', 'Yellow', 10, 0, 1), // 20
      row(1, 21, 'txn-1', 'Yellow', 4, 0, 0), // 4
      row(2, 22, 'claimed', 'Blue', 15, 0, 0), // 15
      // Hidden from every standing: banned, deleted, leaderboard-excluded.
      row(BANNED, 23, 'claimed', 'Pink', 100, 0, 0),
      row(DELETED, 24, 'claimed', 'Green', 200, 0, 0),
      row(EXCLUDED, 24, 'claimed', 'Green', 300, 0, 0),
    ];
    await runCosmeticPlacementScoring(event, DAY1);
    ch.rows = [row(2, 22, 'claimed', 'Blue', 10, 0, 0)];
    await runCosmeticPlacementScoring(event, DAY2);
  });

  it('totals and ranks teams, leaving banned, deleted and excluded users out', async () => {
    const { teams } = await getEventStandings(event);
    expect(teams).toEqual([
      { team: 'Blue', score: 25, rank: 1 },
      { team: 'Yellow', score: 24, rank: 2 },
      { team: 'Pink', score: 0, rank: 3 },
      { team: 'Green', score: 0, rank: 4 },
    ]);
  });

  it('ranks cosmetic instances, so two copies of one design score separately', async () => {
    const { topCosmetics, topUsers } = await getEventStandings(event);
    expect(topCosmetics.map((c) => [c.userId, c.claimKey, c.points])).toEqual([
      [2, 'claimed', 25],
      [1, 'claimed', 20],
      [1, 'txn-1', 4],
    ]);
    expect(topUsers).toEqual({
      Blue: [{ userId: 2, points: 25 }],
      Yellow: [{ userId: 1, points: 24 }],
    });
  });

  it('builds cumulative history per team from the same snapshot', async () => {
    const history = await getTeamScoreHistory(event);
    const blue = history.find((h) => h.team === 'Blue')!;
    expect(blue.scores.map((s) => [s.date.toISOString().slice(0, 10), s.score])).toEqual([
      ['2026-11-12', 15],
      ['2026-11-13', 25],
    ]);
    expect(history.find((h) => h.team === 'Pink')!.scores).toEqual([]);
  });

  it('reads per-cosmetic and per-user scores across days', async () => {
    const scores = await getCosmeticScores(event.name, [
      { userId: 2, cosmeticId: 22, claimKey: 'claimed' },
      { userId: 1, cosmeticId: 21, claimKey: 'txn-1' },
      { userId: 9, cosmeticId: 99, claimKey: 'nope' },
    ]);
    expect(Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.points]))).toEqual({
      '2:22:claimed': 25,
      '1:21:txn-1': 4,
    });
    expect((await getUserCosmeticScores(event.name, 1)).map((c) => [c.claimKey, c.points])).toEqual(
      [
        ['claimed', 20],
        ['txn-1', 4],
      ]
    );
  });

  it('keeps a hidden owner per-cosmetic score readable (standings hide it, cosmetic reads do not)', async () => {
    const scores = await getCosmeticScores(event.name, [
      { userId: BANNED, cosmeticId: 23, claimKey: 'claimed' },
    ]);
    expect(scores[`${BANNED}:23:claimed`]?.points).toBe(100);
  });

  it('builds the snapshot from the primary, not a replica that has not caught up', async () => {
    // A lagging replica: it has none of the rows the job just wrote.
    dbMock.dbRead.$queryRaw.mockImplementation((async () => []) as never);
    ch.rows = [row(1, 21, 'claimed', 'Yellow', 1, 0, 0)];
    await runCosmeticPlacementScoring(event, DAY2);

    const snapshot = redisMock.redis.packed.set.mock.calls.at(-1)?.[1] as {
      teams: { team: string; score: number }[];
    };
    expect(snapshot.teams.find((t) => t.team === 'Yellow')?.score).toBe(25);
  });

  it('rebuilds a cold snapshot on a request from the replica, not the primary', async () => {
    dbMock.dbWrite.$queryRaw.mockClear();
    const { teams } = await getEventStandings(event);
    expect(teams[0]).toEqual({ team: 'Blue', score: 25, rank: 1 });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('serves standings and history from the cached snapshot without querying', async () => {
    const cached = {
      teams: [{ team: 'Green', score: 7, rank: 1 }],
      history: [{ team: 'Green', scores: [{ date: new Date('2026-11-12T00:00:00Z'), score: 7 }] }],
      topCosmetics: [],
      topUsers: {},
      updatedAt: new Date(),
    };
    redisMock.redis.packed.get.mockResolvedValue(cached);
    dbMock.dbWrite.$queryRaw.mockClear();

    expect(await getEventStandings(event)).toBe(cached);
    expect(await getTeamScoreHistory(event)).toBe(cached.history);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('mirroring the ledger to ClickHouse', () => {
  const placed = (id: number, updatedAt: string, extra: object = {}) => ({
    id: BigInt(id),
    event: 'scoretest',
    userId: 1,
    cosmeticId: 21,
    claimKey: 'claimed',
    team: 'Yellow',
    entityType: 'Image',
    entityId: 10 + id,
    entityOwnerId: 1,
    startedAt: new Date('2026-11-12T01:00:00.000Z'),
    endedAt: null,
    updatedAt: new Date(updatedAt),
    ...extra,
  });

  it('sends changed rows synchronously, then advances the watermark to the newest one', async () => {
    dbMock.dbWrite.eventCosmeticPlacement.findMany.mockResolvedValue([
      placed(1, '2026-11-12T02:00:00.000Z', { endedAt: new Date('2026-11-12T02:00:00.000Z') }),
      placed(2, '2026-11-12T03:00:00.000Z', { entityOwnerId: null, entityType: 'Post' }),
    ] as never);
    ch.rows = [];
    await runCosmeticPlacementScoring(event, DAY1);

    expect(dbMock.dbWrite.eventCosmeticPlacement.findMany).toHaveBeenCalledWith({
      where: { event: 'scoretest', updatedAt: { gte: new Date(0) } },
      orderBy: { updatedAt: 'asc' },
    });
    const { values, clickhouse_settings, table } = ch.insert.mock.calls[0][0];
    expect(table).toBe('event_cosmetic_placements');
    expect(clickhouse_settings).toEqual({ async_insert: 0 });
    expect(values).toEqual([
      expect.objectContaining({
        id: 1,
        startedAt: '2026-11-12 01:00:00.000',
        endedAt: '2026-11-12 02:00:00.000',
        entityOwnerId: 1,
      }),
      expect.objectContaining({ id: 2, endedAt: null, entityOwnerId: 0, entityType: 'Post' }),
    ]);
    expect(redisMock.redis.set).toHaveBeenCalledWith(
      expect.stringContaining('scoretest:placement-sync'),
      String(new Date('2026-11-12T03:00:00.000Z').getTime())
    );
  });

  it('rewinds the watermark five minutes on the next run', async () => {
    const watermark = new Date('2026-11-12T03:00:00.000Z').getTime();
    redisMock.redis.get.mockResolvedValue(String(watermark));
    ch.rows = [];
    await runCosmeticPlacementScoring(event, DAY1);

    expect(dbMock.dbWrite.eventCosmeticPlacement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { event: 'scoretest', updatedAt: { gte: new Date(watermark - 5 * 60 * 1000) } },
      })
    );
  });

  it('keeps the watermark when the insert fails, so the rows are sent again next hour', async () => {
    dbMock.dbWrite.eventCosmeticPlacement.findMany.mockResolvedValue([
      placed(1, '2026-11-12T02:00:00.000Z'),
    ] as never);
    ch.insert.mockRejectedValue(new Error('clickhouse down'));

    await expect(runCosmeticPlacementScoring(event, DAY1)).rejects.toThrow('clickhouse down');
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });
});
