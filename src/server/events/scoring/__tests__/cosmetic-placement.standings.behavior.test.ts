import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as SignalClient from '~/utils/signal-client';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The Postgres half of event scoring, on an in-process Postgres running the committed migrations: the
 * daily snapshot the hourly referee writes, and every standings read built from it. ClickHouse is
 * faked; the referee query itself is checked against fixtures by scripts/check-event-points-sql.mjs.
 */

const ch = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { query: ch.query } }));
const signals = vi.hoisted(() => ({ topicSend: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('~/utils/signal-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SignalClient>()),
  signalClient: signals,
}));
const failOpen = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: failOpen.log }));
const engine = vi.hoisted(() => ({ on: true }));
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => engine.on,
  isEventPointsEnabledSync: () => engine.on,
}));

const {
  getCosmeticScores,
  getEventStandings,
  getTeamScoreHistory,
  getUserCosmeticScores,
  refreshStandings,
} = await import('~/server/events/scoring/cosmetic-placement.service');
const { runEventPointsReferee } = await import('~/server/events/points/referee');
const { eventPointsRefereeUsersSql } = await import('~/server/events/points/referee.sql');
const { eventSeasonKeys, hatTopicId } = await import('~/server/events/points/keys');

const MIGRATIONS = ['20261012130000_event_cosmetic_placement', '20261015120000_event_points'].map(
  (name) =>
    path.resolve(
      __dirname,
      `../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    )
);
const db = { pg: null as unknown as PGlite };

const BANNED = 3;
const DELETED = 4;
const EXCLUDED = 5;
// Registered first inside the new-account window, but deleted: the threshold skips it.
const DELETED_NEWBIE = 6;
const NEWBIE = 7;

const event = {
  name: 'scoretest',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  teams: ['Yellow', 'Blue', 'Pink', 'Green'] as const,
};

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
      "excludeFromLeaderboards" boolean NOT NULL DEFAULT false,
      "createdAt" timestamp(3) NOT NULL DEFAULT '2020-01-01'
    );
    -- Ids in registration order. The new-account window opens 2026-10-25 00:00: user 2 registered a
    -- second before it, DELETED_NEWBIE on it, NEWBIE a second later, user 8 after.
    INSERT INTO "User" ("id", "bannedAt", "deletedAt", "excludeFromLeaderboards", "createdAt") VALUES
      (1, NULL, NULL, false, '2020-01-01'), (2, NULL, NULL, false, '2026-10-24 23:59:59'),
      (${BANNED}, now(), NULL, false, '2026-10-24'), (${DELETED}, NULL, now(), false, '2026-10-24'),
      (${EXCLUDED}, NULL, NULL, true, '2026-10-24'), (${DELETED_NEWBIE}, NULL, now(), false, '2026-10-25'),
      (${NEWBIE}, NULL, NULL, false, '2026-10-25 00:00:01'), (8, NULL, NULL, false, '2026-10-30');
  `);
  // A multi-statement string runs as one implicit transaction, which CREATE INDEX CONCURRENTLY
  // refuses; it is applied on its own, as the migration says.
  for (const file of MIGRATIONS) {
    const sql = readFileSync(file, 'utf8');
    const concurrent = sql.match(/CREATE INDEX CONCURRENTLY[^;]*;/g) ?? [];
    await db.pg.exec(concurrent.reduce((rest, statement) => rest.replace(statement, ''), sql));
    for (const statement of concurrent) await db.pg.exec(statement);
  }
});

afterAll(async () => {
  await db.pg.close();
});

// sysRedis as a key-value store: the hourly job writes the snapshot here and every read serves it.
const store = {
  values: new Map<string, unknown>(),
  hashes: new Map<string, Record<string, string>>(),
};
function fakeSysRedis() {
  store.values.clear();
  store.hashes.clear();
  const sys = redisMock.sysRedis;
  sys.packed.get.mockImplementation(
    async (k: string) => structuredClone(store.values.get(k)) ?? null
  );
  sys.packed.set.mockImplementation(async (k: string, v: unknown) => {
    store.values.set(k, structuredClone(v));
    return 'OK';
  });
  sys.hGet.mockImplementation(async (k: string, f: string) => store.hashes.get(k)?.[f] ?? null);
  sys.hmGet.mockImplementation(async (k: string, fields: string[]) =>
    fields.map((f) => store.hashes.get(k)?.[f] ?? null)
  );
  sys.hSet.mockImplementation(async (k: string, v: Record<string, string>) => {
    store.hashes.set(k, { ...(store.hashes.get(k) ?? {}), ...v });
    return Object.keys(v).length;
  });
  sys.del.mockImplementation(
    async (keys: string[]) => keys.filter((k) => store.hashes.delete(k)).length
  );
  sys.multi.mockImplementation(() => {
    const ops: (() => void)[] = [];
    const tx = {
      rename: (a: string, b: string) => {
        ops.push(() => {
          store.hashes.set(b, store.hashes.get(a)!);
          store.hashes.delete(a);
        });
        return tx;
      },
      del: (keys: string[]) => (ops.push(() => keys.forEach((k) => store.hashes.delete(k))), tx),
      exec: async () => ops.forEach((op) => op()),
    };
    return tx;
  });
}

// Every read below runs with this on: the only proof that a read never touches Postgres.
function forbidPostgres() {
  for (const client of [dbMock.dbWrite, dbMock.dbRead]) {
    client.$queryRaw.mockImplementation((async () => {
      throw new Error('Postgres read on the request path');
    }) as never);
    client.$executeRaw.mockImplementation((async () => {
      throw new Error('Postgres write on the request path');
    }) as never);
  }
}

// The hourly job's write, then Postgres goes away.
async function settle(...events: (typeof event & { scoreFrom?: Date })[]) {
  for (const e of events.length ? events : [event])
    await refreshStandings(e, dbMock.dbWrite as never);
  forbidPostgres();
}

beforeEach(async () => {
  await db.pg.exec(`TRUNCATE "EventCosmeticScoreDaily"`);
  vi.clearAllMocks();
  const raw = pgliteRaw(db.pg);
  for (const client of [dbMock.dbWrite, dbMock.dbRead]) {
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
  }
  // The array form only: the statements already ran when their promises were created, so this proves
  // ordering, not atomicity.
  dbMock.dbWrite.$transaction.mockImplementation((async (ops: Promise<unknown>[]) =>
    Promise.all(ops)) as never);
  fakeSysRedis();
});

type Day = {
  day: string;
  userId: number;
  cosmeticId: number;
  claimKey: string;
  team: string;
  points: number;
};
const day = (
  date: string,
  userId: number,
  cosmeticId: number,
  claimKey: string,
  team: string,
  points: number
): Day => ({ day: date, userId, cosmeticId, claimKey, team, points });

async function insertDays(rows: Day[]) {
  for (const r of rows)
    await db.pg.query(
      `INSERT INTO "EventCosmeticScoreDaily" (event, day, "userId", "cosmeticId", "claimKey", team, points, impressions)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $7)`,
      [event.name, r.day, r.userId, r.cosmeticId, r.claimKey, r.team, r.points]
    );
}

async function stored() {
  const res = await db.pg.query<Record<string, unknown>>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, "userId", "claimKey", points
     FROM "EventCosmeticScoreDaily" ORDER BY day, "userId", "claimKey"`
  );
  return res.rows.map((r) => [r.day, r.userId, r.claimKey, r.points]);
}

const zeroStandings = {
  teams: [
    { team: 'Yellow', score: 0, rank: 1 },
    { team: 'Blue', score: 0, rank: 2 },
    { team: 'Pink', score: 0, rank: 3 },
    { team: 'Green', score: 0, rank: 4 },
  ],
  history: event.teams.map((team) => ({ team, scores: [] })),
  topCosmetics: [],
  topUsers: {},
  updatedAt: new Date(0),
};

describe('standings', () => {
  beforeEach(async () => {
    await insertDays([
      day('2026-11-02', 1, 21, 'claimed', 'Yellow', 20),
      day('2026-11-02', 1, 21, 'txn-1', 'Yellow', 4),
      day('2026-11-02', 2, 22, 'claimed', 'Blue', 15),
      // Hidden from every standing: banned, deleted, leaderboard-excluded.
      day('2026-11-02', BANNED, 23, 'claimed', 'Pink', 100),
      day('2026-11-02', DELETED, 24, 'claimed', 'Green', 200),
      day('2026-11-02', EXCLUDED, 24, 'claimed', 'Green', 300),
      day('2026-11-03', 2, 22, 'claimed', 'Blue', 10),
    ]);
  });

  it('totals and ranks teams, leaving banned, deleted and excluded users out', async () => {
    await settle();
    const { teams } = await getEventStandings(event);
    expect(teams).toEqual([
      { team: 'Blue', score: 25, rank: 1 },
      { team: 'Yellow', score: 24, rank: 2 },
      { team: 'Pink', score: 0, rank: 3 },
      { team: 'Green', score: 0, rank: 4 },
    ]);
  });

  it('ranks cosmetic instances, so two copies of one design score separately', async () => {
    await settle();
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
    await settle();
    const history = await getTeamScoreHistory(event);
    const blue = history.find((h) => h.team === 'Blue')!;
    expect(blue.scores.map((s) => [s.date.toISOString().slice(0, 10), s.score])).toEqual([
      ['2026-11-02', 15],
      ['2026-11-03', 25],
    ]);
    expect(history.find((h) => h.team === 'Pink')!.scores).toEqual([]);
  });

  it('reads per-cosmetic and per-user scores across days', async () => {
    await settle();
    const scores = await getCosmeticScores(event, [
      { userId: 2, cosmeticId: 22, claimKey: 'claimed' },
      { userId: 1, cosmeticId: 21, claimKey: 'txn-1' },
      { userId: 9, cosmeticId: 99, claimKey: 'nope' },
    ]);
    expect(Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.points]))).toEqual({
      '2:22:claimed': 25,
      '1:21:txn-1': 4,
    });
    expect(scores['2:22:claimed']).toEqual({
      userId: 2,
      cosmeticId: 22,
      claimKey: 'claimed',
      team: 'Blue',
      points: 25,
      impressions: 25,
      anonImpressions: 0,
      reactions: 0,
      comments: 0,
      stickers: 0,
      remixes: 0,
      modelLikes: 0,
    });
    expect((await getUserCosmeticScores(event, 1)).map((c) => [c.claimKey, c.points])).toEqual([
      ['claimed', 20],
      ['txn-1', 4],
    ]);
    expect(await getUserCosmeticScores(event, 9)).toEqual([]);
  });

  it('keeps a hidden owner per-cosmetic score readable (standings hide it, cosmetic reads do not)', async () => {
    await settle();
    const scores = await getCosmeticScores(event, [
      { userId: BANNED, cosmeticId: 23, claimKey: 'claimed' },
    ]);
    expect(scores[`${BANNED}:23:claimed`]?.points).toBe(100);
  });

  it('builds the hourly snapshot from the client it is given, not a replica that has not caught up', async () => {
    // A lagging replica: it has none of the rows.
    dbMock.dbRead.$queryRaw.mockImplementation((async () => []) as never);
    await settle();
    expect((await getEventStandings(event)).teams.find((t) => t.team === 'Yellow')?.score).toBe(24);
    expect((await getUserCosmeticScores(event, 1)).map((c) => c.points)).toEqual([20, 4]);
  });

  it('writes the standings with no expiry, so the final numbers outlive the event', async () => {
    await settle();
    const writes = redisMock.sysRedis.packed.set.mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(2);
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
  });

  it('replaces the hat totals on each run: a hat whose days were removed reads as unsettled', async () => {
    await settle();
    await db.pg.exec(`DELETE FROM "EventCosmeticScoreDaily" WHERE "claimKey" = 'txn-1'`);
    const raw = pgliteRaw(db.pg);
    dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
    await settle();
    expect(
      await getCosmeticScores(event, [{ userId: 1, cosmeticId: 21, claimKey: 'txn-1' }])
    ).toEqual({});
    expect((await getUserCosmeticScores(event, 1)).map((c) => c.claimKey)).toEqual(['claimed']);
  });

  it('clears the hat totals when a run finds no rows at all', async () => {
    await settle();
    await db.pg.exec(`TRUNCATE "EventCosmeticScoreDaily"`);
    const raw = pgliteRaw(db.pg);
    dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
    await settle();
    expect(
      await getCosmeticScores(event, [{ userId: 2, cosmeticId: 22, claimKey: 'claimed' }])
    ).toEqual({});
    expect(await getUserCosmeticScores(event, 2)).toEqual([]);
  });

  it('serves an event the job has not settled yet as every team at zero, never reading Postgres', async () => {
    forbidPostgres();
    expect(await getEventStandings(event)).toEqual(zeroStandings);
    expect(await getTeamScoreHistory(event)).toEqual(zeroStandings.history);
    expect(
      await getCosmeticScores(event, [{ userId: 2, cosmeticId: 22, claimKey: 'claimed' }])
    ).toEqual({});
    expect(await getUserCosmeticScores(event, 2)).toEqual([]);
  });

  it('rebuilds a missing snapshot for a job from the database it is given, and stores it', async () => {
    const { teams } = await getEventStandings(event, { rebuildFrom: dbMock.dbWrite as never });
    expect(teams[0]).toEqual({ team: 'Blue', score: 25, rank: 1 });
    forbidPostgres();
    expect((await getEventStandings(event)).teams[0]).toEqual({ team: 'Blue', score: 25, rank: 1 });
  });

  it('serves zeros when sysRedis is unreachable on a request, and says it degraded', async () => {
    await settle();
    redisMock.sysRedis.packed.get.mockRejectedValue(new Error('sysRedis down'));
    redisMock.sysRedis.hGet.mockRejectedValue(new Error('sysRedis down'));
    redisMock.sysRedis.hmGet.mockRejectedValue(new Error('sysRedis down'));
    const onDegraded = vi.fn();
    expect(await getEventStandings(event, { onDegraded })).toEqual(zeroStandings);
    expect(
      await getCosmeticScores(
        event,
        [{ userId: 2, cosmeticId: 22, claimKey: 'claimed' }],
        onDegraded
      )
    ).toEqual({});
    expect(await getUserCosmeticScores(event, 2, onDegraded)).toEqual([]);
    expect(onDegraded).toHaveBeenCalledTimes(3);
    expect(failOpen.log.mock.calls.map(([kind, where]) => [kind, where])).toEqual([
      ['read-degraded', 'getEventStandings'],
      ['read-degraded', 'getCosmeticScores'],
      ['read-degraded', 'getUserCosmeticScores'],
    ]);
  });

  it('fails a job read when sysRedis is unreachable, so the payout never runs on zeros', async () => {
    redisMock.sysRedis.packed.get.mockRejectedValue(new Error('sysRedis down'));
    await expect(
      getEventStandings(event, { rebuildFrom: dbMock.dbWrite as never })
    ).rejects.toThrow('sysRedis down');
  });

  it('serves standings and history from the stored snapshot without querying', async () => {
    const cached = {
      teams: [{ team: 'Green', score: 7, rank: 1 }],
      history: [{ team: 'Green', scores: [{ date: new Date('2026-11-02T00:00:00Z'), score: 7 }] }],
      topCosmetics: [],
      topUsers: {},
      updatedAt: new Date(),
    };
    redisMock.sysRedis.packed.get.mockResolvedValue(cached);
    forbidPostgres();

    expect(await getEventStandings(event)).toBe(cached);
    expect(await getTeamScoreHistory(event)).toBe(cached.history);
  });
});

// The preview's days stay in the table after launch. Every read counts only days from scoreFrom
// (the start by default), so they never reach the public standings or anyone's score.
describe('scoreFrom', () => {
  const PREVIEW_FROM = new Date('2026-10-09T00:00:00.000Z');
  const preview = { ...event, scoreFrom: PREVIEW_FROM };

  beforeEach(async () => {
    await insertDays([
      day('2026-10-20', 1, 21, 'claimed', 'Yellow', 7),
      day('2026-11-02', 1, 21, 'claimed', 'Yellow', 3),
    ]);
  });

  it('keeps preview days out of every read once the event has started', async () => {
    await settle(event, preview);
    const { teams, history } = await getEventStandings(event);
    expect(teams.find((t) => t.team === 'Yellow')?.score).toBe(3);
    expect(history.find((h) => h.team === 'Yellow')!.scores.map((x) => x.score)).toEqual([3]);
    const key = { userId: 1, cosmeticId: 21, claimKey: 'claimed' };
    expect((await getCosmeticScores(event, [key]))['1:21:claimed']?.points).toBe(3);
    expect((await getUserCosmeticScores(event, 1))[0]?.points).toBe(3);
  });

  it('positive control: read from the preview start, the same rows include the preview day', async () => {
    await settle(preview, event);
    expect((await getUserCosmeticScores(preview, 1))[0]?.points).toBe(10);
    const key = { userId: 1, cosmeticId: 21, claimKey: 'claimed' };
    expect((await getCosmeticScores(preview, [key]))['1:21:claimed']?.points).toBe(10);
    expect((await getEventStandings(preview)).teams[0]).toEqual({
      team: 'Yellow',
      score: 10,
      rank: 1,
    });
  });
});

// The referee's Postgres writes: which days it replaces, which it keeps, and the restriction lists it
// reads from "User".
describe('referee snapshot', () => {
  const scored = {
    ...event,
    scoring: {
      capPerActorPerOwnerPerDay: 50,
      types: { view: { weight: 1, once: 'day' as const, entities: ['Image' as const] } },
      newAccountDays: 7,
      finalizeAfterMs: 0,
    },
  };
  // An hourly run: recomputes from 2026-11-04.
  const HOURLY = new Date('2026-11-05T12:07:00.000Z');
  const keys = eventSeasonKeys(event.name, 'live');
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  let involved: { actors: number[]; owners: number[] };
  const refereeRow = (date: string, points: number) => ({
    ...day(date, 1, 21, 'claimed', 'Yellow', points),
    views: points,
    reactions: 0,
    comments: 0,
    stickers: 0,
    remixes: 0,
    modelLikes: 0,
  });

  beforeEach(() => {
    strings.clear();
    hashes.clear();
    involved = { actors: [1, 2, BANNED, DELETED, EXCLUDED, NEWBIE, 8], owners: [1, BANNED] };
    const sys = redisMock.sysRedis;
    sys.get.mockImplementation(async (k: string) => strings.get(k) ?? null);
    sys.hGetAll.mockImplementation(async (k: string) => ({ ...(hashes.get(k) ?? {}) }));
    sys.del.mockImplementation(async (k: string) => Number(hashes.delete(k)));
    sys.hSet.mockImplementation(async (k: string, v: Record<string, string>) => {
      hashes.set(k, { ...(hashes.get(k) ?? {}), ...v });
      return 1;
    });
    sys.sAdd.mockResolvedValue(1);
    sys.multi.mockImplementation(() => {
      const ops: (() => void)[] = [];
      const tx = {
        rename: (a: string, b: string) => (ops.push(() => hashes.set(b, hashes.get(a)!)), tx),
        del: (k: string) => (ops.push(() => hashes.delete(k)), tx),
        set: (k: string, v: string) => (ops.push(() => strings.set(k, v)), tx),
        exec: async () => ops.forEach((op) => op()),
      };
      return tx;
    });
    ch.query.mockImplementation(async ({ query }: { query: string }) => ({
      json: async () =>
        query === eventPointsRefereeUsersSql
          ? [involved]
          : [refereeRow('2026-11-04', 5), refereeRow('2026-11-05', 3)],
    }));
  });

  it('replaces only the recomputed days, keeps the final ones, and bases the live total on both', async () => {
    await insertDays([
      day('2026-11-02', 1, 21, 'claimed', 'Yellow', 10),
      day('2026-11-04', 1, 21, 'claimed', 'Yellow', 99),
    ]);
    const result = await runEventPointsReferee(scored, 'live', HOURLY);

    expect(result.recomputeFrom).toBe('2026-11-04T00:00:00.000Z');
    expect(await stored()).toEqual([
      ['2026-11-02', 1, 'claimed', 10],
      ['2026-11-04', 1, 'claimed', 5],
      ['2026-11-05', 1, 'claimed', 3],
    ]);
    expect(hashes.get(keys.base('hat'))).toEqual({ '1:21:claimed': '18' });
    expect(hashes.get(keys.base('team'))).toEqual({ Yellow: '18' });
  });

  it('rerunning the same hour changes nothing', async () => {
    await insertDays([day('2026-11-02', 1, 21, 'claimed', 'Yellow', 10)]);
    await runEventPointsReferee(scored, 'live', HOURLY);
    await runEventPointsReferee(scored, 'live', HOURLY);
    expect(await stored()).toEqual([
      ['2026-11-02', 1, 'claimed', 10],
      ['2026-11-04', 1, 'claimed', 5],
      ['2026-11-05', 1, 'claimed', 3],
    ]);
    expect(hashes.get(keys.base('hat'))).toEqual({ '1:21:claimed': '18' });
  });

  // The referee runs in a job: its corrections reach the screens before it returns, read back
  // through the live read path, never as a preview total.
  it('pushes its corrections before it returns, and none for the preview season', async () => {
    vi.useFakeTimers({ now: HOURLY, toFake: ['Date'] });
    try {
      redisMock.sysRedis.hmGet.mockImplementation(async (k: string, fields: string[]) =>
        fields.map((f) => hashes.get(k)?.[f] ?? null)
      );
      signals.topicSend.mockClear();
      const withPreview = { ...scored, previewFrom: new Date('2026-10-20T00:00:00.000Z') };
      const preview = await runEventPointsReferee(withPreview, 'preview', HOURLY);
      // The preview run did settle and correct something, so its silence is the rule's doing.
      expect(preview.changed).toBe(1);
      expect(signals.topicSend).not.toHaveBeenCalled();

      // Switched off, the live correction is counted as unpushed and nothing is sent.
      engine.on = false;
      const off = await runEventPointsReferee(scored, 'live', HOURLY);
      engine.on = true;
      expect(off).toEqual(expect.objectContaining({ changed: 1, unpushed: 1 }));
      expect(signals.topicSend).not.toHaveBeenCalled();

      // The same run with the switch on, from the same starting state.
      strings.clear();
      hashes.clear();
      const live = await runEventPointsReferee(scored, 'live', HOURLY);
      expect(live).toEqual(expect.objectContaining({ changed: 1, unpushed: 0 }));
      const topicId = hatTopicId({ ownerId: 1, cosmeticId: 21, claimKey: 'claimed' });
      expect(signals.topicSend.mock.calls).toEqual([
        [
          {
            topic: 'event-points:scoretest:teams',
            target: 'event-points:teams',
            data: { event: 'scoretest', teams: { Yellow: 8, Blue: 0, Pink: 0, Green: 0 } },
          },
        ],
        [
          {
            topic: `event-points:scoretest:hat:${topicId}`,
            target: 'event-points:hat',
            data: { event: 'scoretest', topicId, points: 8 },
          },
        ],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  const refereeParams = () =>
    ch.query.mock.calls.find(([{ query }]) => query !== eventPointsRefereeUsersSql)![0]
      .query_params;

  it('restricts banned, deleted and excluded people, and new accounts from the first one registered in the window', async () => {
    await runEventPointsReferee(scored, 'live', HOURLY);
    const { restrictedUsers, newAccountMinId } = refereeParams();
    expect([...restrictedUsers].sort()).toEqual([BANNED, DELETED, EXCLUDED]);
    expect(newAccountMinId).toBe(NEWBIE);
  });

  it('restricts no one as new when nobody registered inside the window', async () => {
    await runEventPointsReferee(
      { ...scored, scoring: { ...scored.scoring, newAccountDays: 0 } },
      'live',
      HOURLY
    );
    expect(refereeParams().newAccountMinId).toBe(2147483647);
  });

  it('looks the involved people up in chunks, finding a restricted one past the first chunk', async () => {
    involved = {
      actors: [...Array.from({ length: 10_000 }, (_, i) => 100_000 + i), BANNED],
      owners: [1],
    };
    await runEventPointsReferee(scored, 'live', HOURLY);
    expect(refereeParams().restrictedUsers).toEqual([BANNED]);
    // Two chunks of hidden lookups, then the new-account threshold.
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('replaces the recomputed days in one transaction', async () => {
    await runEventPointsReferee(scored, 'live', HOURLY);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$transaction.mock.calls[0][0]).toHaveLength(2);
  });
});
