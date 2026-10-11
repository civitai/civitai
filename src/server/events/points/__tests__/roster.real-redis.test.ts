import { randomUUID } from 'crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RosterMemberState, RosterSyncDeps } from '~/server/events/points/roster-sync';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

// The rank sets against a real Redis: what the fake in roster.test.ts cannot show, that Redis itself
// orders the packed scores, runs the Lua, and adds increments exactly. CI's unit job runs a Redis
// service and sets ROSTER_REDIS_URL; elsewhere it runs only when that is set, e.g.
//   ROSTER_REDIS_URL=redis://localhost:6379/15 pnpm exec vitest run --project 'unit*' <this file>
// Every key it writes is under a fresh event name, deleted afterwards.
const url = process.env.ROSTER_REDIS_URL;
// CI must run these, not skip them: a lost variable or service would otherwise read as green.
if (process.env.CI && !url)
  throw new Error('ROSTER_REDIS_URL is not set: CI runs a Redis for this');

const { addRosterPoints, eventRosterKeys, RANK_READY, readRosterPage } = await import(
  '~/server/events/points/roster'
);
const { reconcileEventRosters, syncRosterMembersWith } = await import(
  '~/server/events/points/roster-sync'
);
const { MAX_HATS, MAX_POINTS, packStanding, joinMinute } = await import(
  '~/server/events/points/roster-score'
);
const { rosterComparator } = await import('~/shared/utils/roster-order');

const PREVIEW_NOW = new Date('2026-10-20T12:00:00.000Z');
const LIVE_NOW = new Date('2026-11-05T12:00:00.000Z');
const minute = (n: number) => new Date(PREVIEW_NOW.getTime() - n * 60_000);
const hatsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, worn: i === 0, price: null }));
const SORTS = ['hats', 'points', 'newest'] as const;

describe.skipIf(!url)('team roster rank scores on a real Redis', () => {
  const redis = createClient({ url });
  // A second connection, so syncs and awards reach Redis interleaved rather than in one queue.
  const other = createClient({ url });
  const EVENT = {
    name: `roster-real-${randomUUID().slice(0, 8)}`,
    startDate: new Date('2026-11-01T00:00:00.000Z'),
    teams: ['Blue'] as const,
    join: { claimKey: 'claimed', design: 'basic' },
  };
  const keys = eventRosterKeys(EVENT.name);
  const PAGE = { event: EVENT.name, team: 'Blue', startDate: EVENT.startDate } as const;

  const eventKeys = async () => {
    const found: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: `*${EVENT.name}*`, COUNT: 1000 }))
      found.push(...([] as string[]).concat(batch));
    return found;
  };
  const clearEvent = async () => {
    const found = await eventKeys();
    if (found.length) await redis.del(found);
  };
  beforeAll(async () => {
    await Promise.all([redis.connect(), other.connect()]);
  });
  afterAll(async () => {
    await clearEvent();
    await Promise.all([redis.quit(), other.quit()]);
  });

  const member = (userId: number, over: Partial<RosterMemberState> = {}): RosterMemberState => ({
    userId,
    optedIn: true,
    eligible: true,
    team: 'Blue',
    joinedAt: minute(userId % 7),
    hats: hatsOf(1),
    ...over,
  });
  function deps(
    states: RosterMemberState[],
    points: Record<number, number>,
    now = PREVIEW_NOW,
    client = redis
  ) {
    const db = new Map(states.map((s) => [s.userId, s]));
    const d: RosterSyncDeps = {
      redis: client as unknown as RosterSyncDeps['redis'],
      loadStates: async (_e, ids) =>
        ids.map(
          (id) =>
            db.get(id) ?? {
              userId: id,
              optedIn: false,
              eligible: false,
              team: null,
              joinedAt: null,
              hats: [],
            }
        ),
      ownerPoints: async (_e, ids) =>
        Object.fromEntries(ids.map((id) => [String(id), points[id] ?? 0])),
      now: () => now,
    };
    return { d, db };
  }
  const page = (sort: (typeof SORTS)[number], season: 'preview' | 'live', offset = 0, limit = 48) =>
    readRosterPage({ ...PAGE, sort, season, offset, limit }, redis as never);
  async function pageAll(sort: (typeof SORTS)[number], season: 'preview' | 'live') {
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const p = await page(sort, season, offset, 24);
      seen.push(...p.rows.map((r) => r.userId));
      offset = p.nextOffset;
    }
    return seen;
  }

  // The closing condition: across page boundaries, Most hats and Most points come back in one
  // order, the full key's, for a team past 24 members. Ids 1 to 60, so "9" and "10" both occur;
  // most hold one hat and points repeat, so ties span both page boundaries in every sort.
  it('pages a team of 60 in the full key across page boundaries, in every sort', async () => {
    await clearEvent();
    const states = Array.from({ length: 60 }, (_, i) =>
      member(i + 1, { hats: hatsOf((i + 1) % 5 === 0 ? 2 : 1) })
    );
    const points = Object.fromEntries(states.map((x) => [x.userId, (x.userId * 37) % 7]));
    const { d } = deps(states, points);
    await syncRosterMembersWith(
      EVENT,
      states.map((x) => x.userId),
      d
    );
    const rows = states.map((x) => ({
      userId: x.userId,
      hatCount: x.hats.length,
      points: points[x.userId],
      joinedAt: x.joinedAt as Date,
    }));
    const expected = (sort: (typeof SORTS)[number]) =>
      [...rows].sort(rosterComparator(sort, (r) => r.userId)).map((r) => r.userId);
    const ids = states.map((x) => x.userId);

    // Control: on the single-score sets (no ready marker) real Redis returns the same 60 members in
    // another order, because it cuts each tie by member string across the page boundaries.
    await redis.del(keys.rankReady);
    for (const sort of ['hats', 'points'] as const) {
      const single = await pageAll(sort, 'preview');
      expect([...single].sort((a, b) => a - b)).toEqual(ids);
      expect(single).not.toEqual(expected(sort));
    }

    await redis.set(keys.rankReady, RANK_READY);
    for (const sort of SORTS) expect(await pageAll(sort, 'preview')).toEqual(expected(sort));
  });

  it('holds every field exactly at the edges of its bits, through an award', async () => {
    await clearEvent();
    const states = [member(1, { hats: hatsOf(MAX_HATS + 3) })];
    const { d } = deps(states, { 1: MAX_POINTS - 1 });
    await syncRosterMembersWith(EVENT, [1], d);
    await redis.set(keys.rankReady, RANK_READY);
    const join = joinMinute(states[0].joinedAt as Date, EVENT.startDate);
    const exact = (points: number) =>
      SORTS.map((sort) => packStanding(sort, { hats: MAX_HATS, points, joinMinute: join }));
    const scores = () =>
      Promise.all(
        SORTS.map(async (sort) =>
          Number(await redis.zScore(keys.rank('Blue', sort, 'preview'), '1'))
        )
      );
    expect(await scores()).toEqual(exact(MAX_POINTS - 1));
    await addRosterPoints(redis as never, EVENT.name, 'Blue', 'preview', 1, 1);
    expect(await scores()).toEqual(exact(MAX_POINTS));
    const [row] = (await page('points', 'preview')).rows;
    expect([row.hatCount, row.points]).toEqual([MAX_HATS, MAX_POINTS]);
  });

  // A preview-time sync rewrites the live season's hats while keeping its points, while awards add
  // to them on another connection. The Lua reads and writes in one step, so none is lost; a read
  // then a write would drop the awards landing between them.
  it('loses no award to a sync rewriting the same scores at the same time', async () => {
    await clearEvent();
    const { d } = deps([member(1)], { 1: 0 }, PREVIEW_NOW, other);
    await syncRosterMembersWith(EVENT, [1], d);
    await redis.set(keys.rankReady, RANK_READY);
    let awarded = 0;
    for (let round = 0; round < 40; round++) {
      await Promise.all([
        syncRosterMembersWith(EVENT, [1], d),
        ...Array.from({ length: 10 }, async (_, i) => {
          // Spread across the sync's own round trips.
          await new Promise((r) => setTimeout(r, i % 3));
          await addRosterPoints(redis as never, EVENT.name, 'Blue', 'live', 1, 1);
          awarded++;
        }),
      ]);
    }
    for (const sort of SORTS) {
      const [row] = (await page(sort, 'live')).rows;
      expect([sort, row.points, row.hatCount]).toEqual([sort, awarded, 1]);
    }
  });

  it('leaves no test-run hats or points in either season after a reset and the reconcile', async () => {
    await clearEvent();
    const points: Record<number, number> = { 1: 400, 2: 900 };
    const { d, db } = deps(
      [member(1, { hats: hatsOf(2) }), member(2, { hats: hatsOf(2) })],
      points
    );
    await syncRosterMembersWith(EVENT, [1, 2], d);
    await addRosterPoints(redis as never, EVENT.name, 'Blue', 'preview', 1, 50);
    db.set(1, member(1, { hats: hatsOf(1) }));
    db.set(2, member(2, { team: null, joinedAt: null, hats: [] }));
    points[1] = 0;
    points[2] = 0;
    const gate = async () => redis.hGetAll(keys.members);
    await reconcileEventRosters({ ...d, gate }, [EVENT]);
    await redis.set(keys.rankReady, RANK_READY);
    for (const season of ['preview', 'live'] as const) {
      const rows = (await page('hats', season)).rows;
      expect(rows.map((r) => [r.userId, r.hatCount, r.points])).toEqual([[1, 1, 0]]);
      for (const sort of SORTS)
        expect(await redis.zScore(keys.rank('Blue', sort, season), '2')).toBeNull();
    }
  });

  it('writes the live season exactly once it has started', async () => {
    await clearEvent();
    const { d } = deps([member(1)], { 1: 1234 }, LIVE_NOW);
    await syncRosterMembersWith(EVENT, [1], d);
    await redis.set(keys.rankReady, RANK_READY);
    expect((await page('points', 'live')).rows[0].points).toBe(1234);
  });

  // The Lua packs what it is given, so the sync must clamp: a total past the field would carry
  // into hats and order this member above everyone.
  it('clamps a sync total past the points field before it reaches the Lua', async () => {
    await clearEvent();
    const { d } = deps(
      [member(1), member(2, { hats: hatsOf(2) })],
      { 1: MAX_POINTS + 5, 2: 0 },
      LIVE_NOW
    );
    await syncRosterMembersWith(EVENT, [1, 2], d);
    await redis.set(keys.rankReady, RANK_READY);
    expect((await page('hats', 'live')).rows.map((r) => [r.userId, r.hatCount, r.points])).toEqual([
      [2, 2, 0],
      [1, 1, MAX_POINTS],
    ]);
  });

  // An award past the field carries into the next one and mis-orders the member; the reconcile
  // rewrites it clamped from the exact total.
  it('puts an award that carried past the points field right at the reconcile', async () => {
    await clearEvent();
    const points: Record<number, number> = { 1: MAX_POINTS - 1, 2: 0 };
    const { d } = deps([member(1), member(2, { hats: hatsOf(2) })], points, LIVE_NOW);
    await syncRosterMembersWith(EVENT, [1, 2], d);
    await redis.set(keys.rankReady, RANK_READY);
    await addRosterPoints(redis as never, EVENT.name, 'Blue', 'live', 1, 5);
    // Carried: 1 now reads as 2 hats on the hats sort and outranks 2.
    expect((await page('hats', 'live')).rows.map((r) => r.userId)).toEqual([1, 2]);
    points[1] = MAX_POINTS + 4;
    await reconcileEventRosters({ ...d, gate: async () => redis.hGetAll(keys.members) }, [EVENT]);
    expect((await page('hats', 'live')).rows.map((r) => [r.userId, r.hatCount, r.points])).toEqual([
      [2, 2, 0],
      [1, 1, MAX_POINTS],
    ]);
  });
});
