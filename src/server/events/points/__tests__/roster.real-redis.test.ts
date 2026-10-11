import { randomUUID } from 'crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RosterMemberState, RosterSyncDeps } from '~/server/events/points/roster-sync';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

// The rank sets against a real Redis: what the fake in roster.test.ts cannot show, that Redis itself
// orders the packed scores, runs the Lua, and adds increments exactly. CI has no Redis, so this runs
// only with ROSTER_REDIS_URL set, e.g.
//   ROSTER_REDIS_URL=redis://localhost:6379/15 pnpm exec vitest run --project 'unit*' <this file>
// Every key it writes is under a fresh event name, deleted afterwards.
const url = process.env.ROSTER_REDIS_URL;

const { addRosterPoints, eventRosterKeys, readRosterPage } = await import(
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
const oneHat = [{ id: 1, worn: true, price: null }];

describe.skipIf(!url)('team roster rank scores on a real Redis', () => {
  const redis = createClient({ url });
  const EVENT = {
    name: `roster-real-${randomUUID().slice(0, 8)}`,
    startDate: new Date('2026-11-01T00:00:00.000Z'),
    teams: ['Blue'] as const,
    join: { claimKey: 'claimed', design: 'basic' },
  };
  const keys = eventRosterKeys(EVENT.name);
  const PAGE = { event: EVENT.name, team: 'Blue', startDate: EVENT.startDate } as const;

  beforeAll(async () => {
    await redis.connect();
  });
  afterAll(async () => {
    const found: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: `*${EVENT.name}*`, COUNT: 1000 }))
      found.push(...([] as string[]).concat(batch));
    if (found.length) await redis.del(found);
    await redis.quit();
  });

  const member = (userId: number, over: Partial<RosterMemberState> = {}): RosterMemberState => ({
    userId,
    optedIn: true,
    eligible: true,
    team: 'Blue',
    joinedAt: minute(userId % 7),
    hats: oneHat,
    ...over,
  });
  function deps(states: RosterMemberState[], points: Record<number, number>, now = PREVIEW_NOW) {
    const db = new Map(states.map((s) => [s.userId, s]));
    const d: RosterSyncDeps = {
      redis: redis as unknown as RosterSyncDeps['redis'],
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
  async function pageAll(sort: 'hats' | 'points' | 'newest', season: 'preview' | 'live') {
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await readRosterPage(
        { ...PAGE, sort, season, offset, limit: 24 },
        redis as never
      );
      seen.push(...page.rows.map((r) => r.userId));
      offset = page.nextOffset;
    }
    return seen;
  }
  const clearTeam = async () => {
    const found: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: `*${EVENT.name}*`, COUNT: 1000 }))
      found.push(...([] as string[]).concat(batch));
    if (found.length) await redis.del(found);
  };

  // The closing condition: across page boundaries, Most hats and Most points come back in one
  // order, the full key's, for a team past 24 members. Ids from 1 to 60, so "9" and "10" both occur.
  it('pages a team of 60 on 1 hat in the full key, across page boundaries', async () => {
    await clearTeam();
    const states = Array.from({ length: 60 }, (_, i) => member(i + 1));
    const points = Object.fromEntries(states.map((x) => [x.userId, (x.userId * 37) % 5]));
    const { d } = deps(states, points);
    await syncRosterMembersWith(
      EVENT,
      states.map((x) => x.userId),
      d
    );
    const rows = states.map((x) => ({
      userId: x.userId,
      hatCount: 1,
      points: points[x.userId],
      joinedAt: x.joinedAt as Date,
    }));
    const expected = (sort: 'hats' | 'points' | 'newest') =>
      [...rows].sort(rosterComparator(sort, (r) => r.userId)).map((r) => r.userId);

    // Control: before the rank sets are marked ready, pages come from the single-score sets, and
    // real Redis cuts the 1-hat tie by member string at each page boundary.
    await redis.del(keys.rankReady);
    expect(await pageAll('hats', 'preview')).not.toEqual(expected('hats'));

    await redis.set(keys.rankReady, '1');
    for (const sort of ['hats', 'points', 'newest'] as const)
      expect(await pageAll(sort, 'preview')).toEqual(expected(sort));
  });

  it('holds every field exactly at the edges of its bits, through an award', async () => {
    await clearTeam();
    const states = [member(1, { hats: Array.from({ length: MAX_HATS + 3 }, () => oneHat[0]) })];
    const { d } = deps(states, { 1: MAX_POINTS - 1 });
    await syncRosterMembersWith(EVENT, [1], d);
    await redis.set(keys.rankReady, '1');
    const join = joinMinute(states[0].joinedAt as Date, EVENT.startDate);
    const exact = (points: number) =>
      (['hats', 'points', 'newest'] as const).map((sort) =>
        packStanding(sort, { hats: MAX_HATS, points, joinMinute: join })
      );
    const scores = async () =>
      Promise.all(
        (['hats', 'points', 'newest'] as const).map(async (sort) =>
          Number(await redis.zScore(keys.rank('Blue', sort, 'preview'), '1'))
        )
      );
    expect(await scores()).toEqual(exact(MAX_POINTS - 1));
    await addRosterPoints(redis as never, EVENT.name, 'Blue', 'preview', 1, 1);
    expect(await scores()).toEqual(exact(MAX_POINTS));
    const [row] = (
      await readRosterPage(
        { ...PAGE, sort: 'points', season: 'preview', offset: 0, limit: 1 },
        redis as never
      )
    ).rows;
    expect([row.hatCount, row.points]).toEqual([MAX_HATS, MAX_POINTS]);
  });

  // A preview-time sync rewrites the live season's hats while keeping its points; the award adds
  // to those points at the same time. The Lua runs in one step, so no increment is lost.
  it('loses no award increment to a sync rewriting the same scores at the same time', async () => {
    await clearTeam();
    const states = [member(1)];
    const { d } = deps(states, { 1: 0 });
    await syncRosterMembersWith(EVENT, [1], d);
    await redis.set(keys.rankReady, '1');
    const grants = Array.from({ length: 300 }, () =>
      addRosterPoints(redis as never, EVENT.name, 'Blue', 'live', 1, 1)
    );
    const syncs = Array.from({ length: 30 }, () => syncRosterMembersWith(EVENT, [1], d));
    await Promise.all([...grants, ...syncs]);
    for (const sort of ['hats', 'points', 'newest'] as const) {
      const [row] = (
        await readRosterPage({ ...PAGE, sort, season: 'live', offset: 0, limit: 1 }, redis as never)
      ).rows;
      expect([sort, row.points, row.hatCount]).toEqual([sort, 300, 1]);
    }
  });

  it('leaves no test-run hats or points in either season after a reset and the reconcile', async () => {
    await clearTeam();
    const twoHats = [...oneHat, { id: 2, worn: false, price: 500 }];
    const points: Record<number, number> = { 1: 400, 2: 900 };
    const { d, db } = deps([member(1, { hats: twoHats }), member(2, { hats: twoHats })], points);
    await syncRosterMembersWith(EVENT, [1, 2], d);
    await addRosterPoints(redis as never, EVENT.name, 'Blue', 'preview', 1, 50);
    db.set(1, member(1, { hats: oneHat }));
    db.set(2, member(2, { team: null, joinedAt: null, hats: [] }));
    points[1] = 0;
    points[2] = 0;
    await reconcileEventRosters({ ...d, gate: async () => redis.hGetAll(keys.members) }, [EVENT]);
    expect(await redis.get(keys.rankReady)).toBe('1');
    for (const season of ['preview', 'live'] as const) {
      const rows = (
        await readRosterPage(
          { ...PAGE, sort: 'hats', season, offset: 0, limit: 48 },
          redis as never
        )
      ).rows;
      expect(rows.map((r) => [r.userId, r.hatCount, r.points])).toEqual([[1, 1, 0]]);
      for (const sort of ['hats', 'points', 'newest'] as const)
        expect(await redis.zScore(keys.rank('Blue', sort, season), '2')).toBeNull();
    }
  });

  it('writes the live season exactly once it has started', async () => {
    await clearTeam();
    const { d } = deps([member(1)], { 1: 1234 }, LIVE_NOW);
    await syncRosterMembersWith(EVENT, [1], d);
    await redis.set(keys.rankReady, '1');
    const [row] = (
      await readRosterPage(
        { ...PAGE, sort: 'points', season: 'live', offset: 0, limit: 1 },
        redis as never
      )
    ).rows;
    expect(row.points).toBe(1234);
  });

  // The Lua packs what it is given, so the sync must clamp: a total past the field would carry
  // into hats and order this member above everyone.
  it('clamps a sync total past the points field before it reaches the Lua', async () => {
    await clearTeam();
    const { d } = deps(
      [member(1), member(2, { hats: [...oneHat, ...oneHat] })],
      {
        1: MAX_POINTS + 5,
        2: 0,
      },
      LIVE_NOW
    );
    await syncRosterMembersWith(EVENT, [1, 2], d);
    await redis.set(keys.rankReady, '1');
    const rows = (
      await readRosterPage(
        { ...PAGE, sort: 'hats', season: 'live', offset: 0, limit: 2 },
        redis as never
      )
    ).rows;
    expect(rows.map((r) => [r.userId, r.hatCount, r.points])).toEqual([
      [2, 2, 0],
      [1, 1, MAX_POINTS],
    ]);
  });
});
