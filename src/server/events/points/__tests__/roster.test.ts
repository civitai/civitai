import { describe, expect, it, vi } from 'vitest';
import type { RosterMemberState, RosterSyncDeps } from '~/server/events/points/roster-sync';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { addRosterPoints, eventRosterKeys, listedOwnerTopics, readRosterPage } = await import(
  '~/server/events/points/roster'
);
type EvalArgs = { keys: string[]; arguments: string[] };
const LIST_IF_UNCHANGED_AS_MEASURED = `local v = redis.call('HGET', KEYS[1], ARGV[1]) or ''
if v == ARGV[2] then redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) return 1 end
return 0`;
const DELETE_IF_UNCHANGED_AS_MEASURED = `for i = 1, #ARGV, 2 do
if redis.call('HGET', KEYS[1], ARGV[i]) == ARGV[i + 1] then redis.call('HDEL', KEYS[1], ARGV[i]) end
end
return 0`;
const {
  isTombstone,
  rebuildEventRoster,
  rosterTeam,
  reconcileEventRosters,
  syncEventRosterMembers,
  syncRosterMembersWith,
} = await import('~/server/events/points/roster-sync');
const { seasonOwnerTopicId } = await import('~/server/events/points/keys');

// A small Redis with real sorted-set and hash semantics, including ZADD's NX / XX conditions: the
// roster's privacy rests on what XX refuses to create and on which keys a write leaves behind, so a
// fake that records calls would test nothing.
function fakeRedis() {
  const zsets = new Map<string, Map<string, number>>();
  const hashes = new Map<string, Map<string, string>>();
  const z = (key: string) => {
    let set = zsets.get(key);
    if (!set) zsets.set(key, (set = new Map()));
    return set;
  };
  const h = (key: string) => {
    let hash = hashes.get(key);
    if (!hash) hashes.set(key, (hash = new Map()));
    return hash;
  };
  const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
  const redis = {
    async zAdd(
      key: string,
      members: { score: number; value: string } | { score: number; value: string }[],
      opts?: { condition?: 'NX' | 'XX' }
    ) {
      let added = 0;
      for (const { score, value } of Array.isArray(members) ? members : [members]) {
        const has = z(key).has(value);
        if (opts?.condition === 'NX' && has) continue;
        if (opts?.condition === 'XX' && !has) continue;
        if (!has) added++;
        z(key).set(value, score);
      }
      return added;
    },
    async zAddIncr(
      key: string,
      { score, value }: { score: number; value: string },
      opts?: { condition?: 'NX' | 'XX' }
    ) {
      const has = z(key).has(value);
      if (opts?.condition === 'XX' && !has) return null;
      if (opts?.condition === 'NX' && has) return null;
      const next = (z(key).get(value) ?? 0) + score;
      z(key).set(value, next);
      return next;
    },
    async zRem(key: string, members: string | string[]) {
      let n = 0;
      for (const m of list(members)) if (z(key).delete(m)) n++;
      return n;
    },
    // Lowest first, ties by member, as Redis orders them; REV reverses both.
    async zRangeWithScores(key: string, start: number, stop: number, opts?: { REV?: boolean }) {
      const rows = [...z(key)]
        .map(([value, score]) => ({ value, score }))
        .sort((a, b) => a.score - b.score || (a.value < b.value ? -1 : 1));
      if (opts?.REV) rows.reverse();
      return rows.slice(start, stop + 1);
    },
    async zCard(key: string) {
      return z(key).size;
    },
    async zmScore(key: string, members: string[]) {
      return members.map((m) => z(key).get(m) ?? null);
    },
    async hSet(key: string, fieldOrRecord: string | Record<string, string>, value?: string) {
      const entries =
        typeof fieldOrRecord === 'string'
          ? [[fieldOrRecord, value!] as const]
          : Object.entries(fieldOrRecord);
      for (const [f, v] of entries) h(key).set(f, v);
      return entries.length;
    },
    async hDel(key: string, fields: string | string[]) {
      let n = 0;
      for (const f of list(fields)) if (h(key).delete(f)) n++;
      return n;
    },
    async hmGet(key: string, fields: string[]) {
      return fields.map((f) => h(key).get(f) ?? null);
    },
    async hGet(key: string, field: string) {
      return h(key).get(field) ?? null;
    },
    // The roster's two scripts: HSET, or HDEL per pair, only if the field still holds what the
    // caller read. The fake can only act out the scripts it knows, so any other text fails here,
    // loudly. What the real scripts do on a real Redis was measured against redis:7 (PR body).
    async eval(script: string, { keys: [key], arguments: args }: EvalArgs) {
      if (script === LIST_IF_UNCHANGED_AS_MEASURED) {
        const [field, expected, value] = args;
        if ((h(key).get(field) ?? '') !== expected) return 0;
        h(key).set(field, value);
        return 1;
      }
      if (script === DELETE_IF_UNCHANGED_AS_MEASURED) {
        for (let i = 0; i < args.length; i += 2)
          if (h(key).get(args[i]) === args[i + 1]) h(key).delete(args[i]);
        return 0;
      }
      throw new Error(`unexpected script: ${script}`);
    },
  };
  // Every key that still names `member`, apart from a tombstone in the gate, which names nobody.
  const allKeysHolding = (member: string) => [
    ...[...zsets].filter(([, s]) => s.has(member)).map(([k]) => k),
    ...[...hashes]
      .filter(
        ([k, m]) =>
          (m.has(member) && !(k === keys.members && isTombstone(m.get(member)))) ||
          [...m.values()].includes(member)
      )
      .map(([k]) => k),
  ];
  return { redis, zsets, hashes, allKeysHolding };
}

const EVENT = {
  name: 'birthday2026',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  teams: ['Blue', 'Pink'] as const,
  join: { claimKey: 'claimed', design: 'basic' },
};
const PREVIEW_NOW = new Date('2026-10-20T12:00:00.000Z');
const LIVE_NOW = new Date('2026-11-05T12:00:00.000Z');
const keys = eventRosterKeys(EVENT.name);

const member = (userId: number, over: Partial<RosterMemberState> = {}): RosterMemberState => ({
  userId,
  optedIn: true,
  eligible: true,
  team: 'Blue',
  joinedAt: new Date(PREVIEW_NOW.getTime() - userId * 60_000),
  hats: [{ id: 100 + userId, worn: true, price: 500 }],
  ...over,
});

function setup(
  states: RosterMemberState[],
  now = PREVIEW_NOW,
  points: Record<string, number> = {}
) {
  const fake = fakeRedis();
  const db = new Map(states.map((s) => [s.userId, s]));
  const deps: RosterSyncDeps = {
    redis: fake.redis as unknown as RosterSyncDeps['redis'],
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
  const read = (
    sort: 'hats' | 'points' | 'newest',
    team = 'Blue',
    season: 'preview' | 'live' = now < EVENT.startDate ? 'preview' : 'live'
  ) =>
    readRosterPage(
      { event: EVENT.name, team, sort, season, offset: 0, limit: 48 },
      fake.redis as never
    );
  return { ...fake, deps, db, read };
}

describe('team roster', () => {
  it('lists an opted-in member in every sort, with their hats, points and join time', async () => {
    const s = setup([member(1, { hats: [{ id: 7, worn: true, price: 3000 }] })], PREVIEW_NOW, {
      1: 42,
    });
    await syncRosterMembersWith(EVENT, [1], s.deps);
    for (const sort of ['hats', 'points', 'newest'] as const) {
      const page = await s.read(sort);
      expect(page.rows).toEqual([
        {
          userId: 1,
          hats: [{ id: 7, worn: true, price: 3000 }],
          hatCount: 1,
          points: 42,
          joinedAt: member(1).joinedAt,
        },
      ]);
    }
  });

  it('sorts each roster by its own score, highest first', async () => {
    const s = setup(
      [
        member(1, { hats: [{ id: 1, worn: true, price: null }] }),
        member(2, {
          hats: [
            { id: 2, worn: true, price: null },
            { id: 3, worn: false, price: 500 },
          ],
        }),
        member(3, { joinedAt: new Date(PREVIEW_NOW.getTime()) }),
      ],
      PREVIEW_NOW,
      { 1: 90, 2: 10, 3: 50 }
    );
    await syncRosterMembersWith(EVENT, [1, 2, 3], s.deps);
    const ids = async (sort: 'hats' | 'points' | 'newest') =>
      (await s.read(sort)).rows.map((r) => r.userId);
    expect(await ids('hats')).toEqual([2, 3, 1]);
    expect(await ids('points')).toEqual([1, 3, 2]);
    expect(await ids('newest')).toEqual([3, 1, 2]);
  });

  // The decision this whole store rests on: a member is hidden unless they opted in. Whatever a
  // sorted set still holds, a read returns only the userIds the members hash names for that team.
  it('never returns a hidden member, even with their scores left in every sorted set', async () => {
    const s = setup([member(1), member(2)], PREVIEW_NOW, { 1: 5, 2: 500 });
    await syncRosterMembersWith(EVENT, [1, 2], s.deps);
    // 2 is hidden, but stale scores for them sit in all four sets (as a lost unlist would leave).
    await s.redis.hDel(keys.members, '2');
    for (const sort of ['hats', 'points', 'newest'] as const) {
      const page = await s.read(sort);
      expect(page.rows.map((r) => r.userId)).toEqual([1]);
    }
    // And someone listed on Pink never shows on Blue, whatever Blue's sets hold.
    await s.redis.hSet(keys.members, '2', 'Pink');
    expect((await s.read('points')).rows.map((r) => r.userId)).toEqual([1]);
  });

  it('lists nobody who has not opted in, joined, or may earn', async () => {
    const s = setup([
      member(1, { optedIn: false }),
      member(2, { team: null }),
      member(3, { eligible: false }),
      member(4, { team: 'Orange' }),
    ]);
    await syncRosterMembersWith(EVENT, [1, 2, 3, 4, 5], s.deps);
    expect([...s.zsets.values()].every((z) => z.size === 0)).toBe(true);
    // The gate holds only tombstones for them; every other hash is empty.
    const gate = [...(s.hashes.get(keys.members)?.values() ?? [])];
    expect(gate).toHaveLength(5);
    expect(gate.every(isTombstone)).toBe(true);
    for (const id of ['1', '2', '3', '4', '5']) expect(s.allKeysHolding(id)).toEqual([]);
  });

  it('takes every trace of a member down when they opt out, are banned or excluded', async () => {
    for (const change of [{ optedIn: false }, { eligible: false }]) {
      const s = setup([member(1), member(2)]);
      await syncRosterMembersWith(EVENT, [1, 2], s.deps);
      expect(s.allKeysHolding('1').length).toBeGreaterThan(0);
      s.db.set(1, member(1, change));
      const { removed } = await syncRosterMembersWith(EVENT, [1], s.deps);
      expect(removed).toBe(1);
      expect(s.allKeysHolding('1')).toEqual([]);
      // Their owner topics are gone, so the pusher and the interest set no longer name them.
      const topics = (['preview', 'live'] as const).map((x) =>
        seasonOwnerTopicId(EVENT.name, 1, x)
      );
      expect(await listedOwnerTopics(EVENT.name, topics, s.redis as never)).toEqual(new Map());
      // The other member is untouched.
      expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([2]);
    }
  });

  it('moves a member whose team changed off the old team', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    s.db.set(1, member(1, { team: 'Pink' }));
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect((await s.read('hats', 'Blue')).total).toBe(0);
    expect((await s.read('hats', 'Pink')).rows.map((r) => r.userId)).toEqual([1]);
  });

  // The award adds a grant with ZADD XX INCR: it never needs to know who opted in.
  it('adds a grant only to a member already listed, and never lists anyone', async () => {
    const s = setup([member(1)], PREVIEW_NOW, { 1: 10 });
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect(await addRosterPoints(s.redis as never, EVENT.name, 'Blue', 'preview', 1, 5)).toBe(15);
    // 2 never opted in: no entry appears in the points set, or anywhere.
    expect(await addRosterPoints(s.redis as never, EVENT.name, 'Blue', 'preview', 2, 5)).toBe(null);
    expect(s.allKeysHolding('2')).toEqual([]);
    expect((await s.read('points')).rows.map((r) => [r.userId, r.points])).toEqual([[1, 15]]);
  });

  it('seeds a later season at zero during the preview, and leaves it once it has started', async () => {
    const s = setup([member(1)], PREVIEW_NOW, { 1: 70 });
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect((await s.read('points', 'Blue', 'live')).rows.map((r) => r.points)).toEqual([0]);
    // The live season's grants land on it, and a later preview-time sync does not reset them.
    await addRosterPoints(s.redis as never, EVENT.name, 'Blue', 'live', 1, 3);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect((await s.read('points', 'Blue', 'live')).rows.map((r) => r.points)).toEqual([3]);
  });

  it('resets points to the exact owner total on reconcile, and drops a member who left', async () => {
    const points: Record<number, number> = { 1: 10, 2: 20 };
    const s = setup([member(1), member(2)], LIVE_NOW, points);
    await syncRosterMembersWith(EVENT, [1, 2], s.deps);
    // Live increments drifted from what the referee settled.
    await addRosterPoints(s.redis as never, EVENT.name, 'Blue', 'live', 1, 999);
    points[1] = 12;
    s.db.set(2, member(2, { eligible: false }));
    await reconcileEventRosters(
      { ...s.deps, gate: async () => Object.fromEntries(s.hashes.get(keys.members) ?? []) },
      [EVENT]
    );
    expect((await s.read('points')).rows.map((r) => [r.userId, r.points])).toEqual([[1, 12]]);
    expect(s.allKeysHolding('2')).toEqual([]);
  });

  it('rebuilds a lost roster from the opted-in users in User.settings', async () => {
    const s = setup([member(1), member(2), member(3, { eligible: false })], LIVE_NOW, { 1: 4 });
    const result = await rebuildEventRoster(EVENT, {
      ...s.deps,
      optedInUserIds: async () => [1, 2, 3],
    });
    expect(result).toEqual({ optedIn: 3, listed: 2 });
    expect((await s.read('points')).rows.map((r) => r.userId).sort()).toEqual([1, 2]);
  });

  it('pages through a roster without repeating or skipping anyone', async () => {
    const states = Array.from({ length: 7 }, (_, i) => member(i + 1));
    const s = setup(states);
    await syncRosterMembersWith(
      EVENT,
      states.map((x) => x.userId),
      s.deps
    );
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await readRosterPage(
        { event: EVENT.name, team: 'Blue', sort: 'hats', season: 'preview', offset, limit: 3 },
        s.redis as never
      );
      seen.push(...page.rows.map((r) => r.userId));
      offset = page.nextOffset;
    }
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  // A sync reads the gate, then Postgres, then lists. An opt-out landing between its read of
  // Postgres and its listing write must win: the stale sync lists nobody and leaves nothing behind.
  it('lets no sync that read before an opt-out list the member after it', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    const stale: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        const states = await s.deps.loadStates(event, ids);
        // The opt-out commits and syncs while this one is between its reads and its writes.
        s.db.set(1, member(1, { optedIn: false }));
        await syncRosterMembersWith(EVENT, [1], s.deps);
        return states;
      },
    };
    await syncRosterMembersWith(EVENT, [1], stale);
    expect(s.allKeysHolding('1')).toEqual([]);
    expect((await s.read('hats')).rows).toEqual([]);
  });

  it('also stops a first opt-in still in flight, when an opt-out lands during it', async () => {
    const s = setup([member(1)]);
    const inFlight: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        const states = await s.deps.loadStates(event, ids);
        s.db.set(1, member(1, { optedIn: false }));
        await syncRosterMembersWith(EVENT, [1], s.deps);
        return states;
      },
    };
    await syncRosterMembersWith(EVENT, [1], inFlight);
    expect(s.allKeysHolding('1')).toEqual([]);
    expect((await s.read('newest')).rows).toEqual([]);
  });

  // A ban, deletion or exclusion is not an opt-out, and the member may never have been listed:
  // it must still stop a first opt-in already in flight.
  it('stops a first opt-in still in flight when a ban lands during it', async () => {
    const s = setup([member(1)]);
    const inFlight: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        const states = await s.deps.loadStates(event, ids);
        s.db.set(1, member(1, { eligible: false }));
        await syncRosterMembersWith(EVENT, [1], s.deps);
        return states;
      },
    };
    await syncRosterMembersWith(EVENT, [1], inFlight);
    expect(s.allKeysHolding('1')).toEqual([]);
    expect((await s.read('points')).rows).toEqual([]);
  });

  // A refused listing takes back only its own leftovers: if another sync listed the member
  // meanwhile, that listing stands.
  it('keeps a listing another sync made while this one was refused', async () => {
    const s = setup([member(1)]);
    const raced: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        const states = await s.deps.loadStates(event, ids);
        // An opt-out, then an opt-in again, both complete while this one is mid-flight.
        s.db.set(1, member(1, { optedIn: false }));
        await syncRosterMembersWith(EVENT, [1], s.deps);
        s.db.set(1, member(1));
        await syncRosterMembersWith(EVENT, [1], s.deps);
        return states;
      },
    };
    await syncRosterMembersWith(EVENT, [1], raced);
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
    expect((await s.read('points')).rows.map((r) => r.userId)).toEqual([1]);
  });

  it('lists a member again once they opt back in', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    s.db.set(1, member(1, { optedIn: false }));
    await syncRosterMembersWith(EVENT, [1], s.deps);
    s.db.set(1, member(1));
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
  });

  it('drops tombstones older than an hour at the reconcile, and keeps newer ones', async () => {
    let now = LIVE_NOW;
    const s = setup([member(1), member(2)], LIVE_NOW);
    s.deps.now = () => now;
    await syncRosterMembersWith(EVENT, [1, 2], s.deps);
    s.db.set(1, member(1, { optedIn: false }));
    await syncRosterMembersWith(EVENT, [1], s.deps);
    const gate = async () => Object.fromEntries(s.hashes.get(keys.members) ?? []);
    now = new Date(LIVE_NOW.getTime() + 30 * 60_000);
    await reconcileEventRosters({ ...s.deps, gate }, [EVENT]);
    expect(isTombstone(s.hashes.get(keys.members)?.get('1'))).toBe(true);
    now = new Date(LIVE_NOW.getTime() + 61 * 60_000);
    await reconcileEventRosters({ ...s.deps, gate }, [EVENT]);
    expect(s.hashes.get(keys.members)?.has('1')).toBe(false);
    expect(rosterTeam(s.hashes.get(keys.members)?.get('2'))).toBe('Blue');
  });

  it('stops starting batches at the deadline and says it did not finish', async () => {
    const states = Array.from({ length: 3 }, (_, i) => member(i + 1));
    const s = setup(states, LIVE_NOW);
    await syncRosterMembersWith(EVENT, [1, 2, 3], s.deps);
    const gate = async () => Object.fromEntries(s.hashes.get(keys.members) ?? []);
    const synced = vi.fn(s.deps.loadStates);
    const deps = { ...s.deps, loadStates: synced, gate };
    expect(await reconcileEventRosters(deps, [EVENT], { deadline: LIVE_NOW.getTime() })).toEqual({
      complete: false,
    });
    expect(synced).not.toHaveBeenCalled();
    expect(
      await reconcileEventRosters(deps, [EVENT], { deadline: LIVE_NOW.getTime() + 1 })
    ).toEqual({
      complete: true,
    });
    expect(synced).toHaveBeenCalledTimes(1);
  });

  // The reconcile reads the gate, then prunes old tombstones by name. A member listed again in
  // between must not lose their gate entry to the prune.
  it('never prunes a tombstone that a sync turned back into a listing', async () => {
    let now = LIVE_NOW;
    const s = setup([member(1)], LIVE_NOW);
    s.deps.now = () => now;
    s.db.set(1, member(1, { optedIn: false }));
    await syncRosterMembersWith(EVENT, [1], s.deps);
    now = new Date(LIVE_NOW.getTime() + 2 * 60 * 60_000);
    const gate = async () => {
      const snapshot = Object.fromEntries(s.hashes.get(keys.members) ?? []);
      // The member opts back in after the snapshot, before the prune.
      s.db.set(1, member(1));
      await syncRosterMembersWith(EVENT, [1], s.deps);
      return snapshot;
    };
    await reconcileEventRosters({ ...s.deps, gate }, [EVENT]);
    expect(rosterTeam(s.hashes.get(keys.members)?.get('1'))).toBe('Blue');
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
  });

  // A heal can stop between batches. Each member is re-derived and overwritten, never added to,
  // so a later run finishes from where it stopped: everyone eligible listed once, at their exact
  // total.
  it('finishes a re-base that a deadline stopped mid-way, with exact totals and nobody missing', async () => {
    const n = 1_200;
    const states = Array.from({ length: n }, (_, i) => member(i + 1));
    const points = Object.fromEntries(states.map((x) => [x.userId, x.userId * 3]));
    let now = LIVE_NOW.getTime();
    const s = setup(states, LIVE_NOW, points);
    s.deps.now = () => new Date(now);
    await syncRosterMembersWith(
      EVENT,
      states.map((x) => x.userId),
      s.deps
    );
    // Drift: live increments past the settled totals, as between referee runs.
    for (const x of states)
      await addRosterPoints(s.redis as never, EVENT.name, 'Blue', 'live', x.userId, 1000);
    const gate = async () => Object.fromEntries(s.hashes.get(keys.members) ?? []);
    // Each batch's Postgres read moves the clock past the deadline: one batch, then it stops.
    const slow: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        now += 60_000;
        return s.deps.loadStates(event, ids);
      },
    };
    const first = await reconcileEventRosters({ ...slow, gate }, [EVENT], {
      deadline: now + 1,
    });
    expect(first).toEqual({ complete: false });
    const drifted = async () =>
      (
        await readRosterPage(
          { event: EVENT.name, team: 'Blue', sort: 'points', season: 'live', offset: 0, limit: 48 },
          s.redis as never
        )
      ).total;
    expect(await drifted()).toBe(n);
    const exact = () =>
      states.filter(
        (x) => s.zsets.get(keys.points('Blue', 'live'))?.get(String(x.userId)) === x.userId * 3
      ).length;
    // Some re-based, the rest still drifted.
    expect(exact()).toBeGreaterThan(0);
    expect(exact()).toBeLessThan(n);
    expect(await reconcileEventRosters({ ...s.deps, gate }, [EVENT])).toEqual({ complete: true });
    expect(exact()).toBe(n);
    expect(s.zsets.get(keys.points('Blue', 'live'))?.size).toBe(n);
    expect(
      [...(s.hashes.get(keys.members)?.values() ?? [])].filter((v) => rosterTeam(v) === 'Blue')
    ).toHaveLength(n);
  });

  it('syncs only listed members on a change that cannot list anyone, in one gate read', async () => {
    const s = setup([member(1), member(2)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    const loaded: number[][] = [];
    const deps: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        loaded.push(ids);
        return s.deps.loadStates(event, ids);
      },
    };
    await syncEventRosterMembers([1, 2, 2], { onlyIfListed: true }, deps, [EVENT]);
    expect(loaded).toEqual([[1]]);
    await syncEventRosterMembers([1, 2], {}, deps, [EVENT]);
    expect(loaded).toEqual([[1], [1, 2]]);
  });

  // The topic map names a listed member's owner topics, in both seasons during the preview, so the
  // pusher and the interest set can find them; the gate still decides.
  it('writes owner topics for a listed member, and serves them only while the gate lists them', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    const topics = (['preview', 'live'] as const).map((x) => seasonOwnerTopicId(EVENT.name, 1, x));
    expect(await listedOwnerTopics(EVENT.name, topics, s.redis as never)).toEqual(
      new Map(topics.map((t) => [t, 1]))
    );
    // A topic entry left behind by a failed unlisting serves nobody once the gate is a tombstone.
    await s.redis.hSet(keys.members, '1', 'x:1');
    expect(await listedOwnerTopics(EVENT.name, topics, s.redis as never)).toEqual(new Map());
  });

  // A prune between a sync's gate read and its write made the gate empty: the write is refused, and
  // the member is derived again from fresh reads instead of being dropped.
  it('lists a member whose old tombstone was pruned while their opt-in synced', async () => {
    const s = setup([member(1)]);
    await s.redis.hSet(keys.members, '1', 'x:1');
    const pruned: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        const states = await s.deps.loadStates(event, ids);
        if (s.hashes.get(keys.members)?.get('1') === 'x:1') await s.redis.hDel(keys.members, '1');
        return states;
      },
    };
    expect(await syncRosterMembersWith(EVENT, [1], pruned)).toEqual({ listed: 1, removed: 0 });
    expect(rosterTeam(s.hashes.get(keys.members)?.get('1'))).toBe('Blue');
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
  });

  // A sync that read someone as not opted in, just before their opt-in landed and listed them, must
  // not tombstone them: its write is refused, and fresh reads see the opt-in.
  it('never hides a member whose opt-in landed during a sync that read them as hidden', async () => {
    const s = setup([member(1, { optedIn: false })]);
    const stale: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        const states = await s.deps.loadStates(event, ids);
        if (!s.hashes.get(keys.members)?.has('1')) {
          s.db.set(1, member(1));
          await syncRosterMembersWith(EVENT, [1], s.deps);
        }
        return states;
      },
    };
    expect(await syncRosterMembersWith(EVENT, [1], stale)).toEqual({ listed: 1, removed: 0 });
    expect(rosterTeam(s.hashes.get(keys.members)?.get('1'))).toBe('Blue');
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
  });

  it('gives up after a few moving gates and leaves the member hidden, with nothing behind', async () => {
    const s = setup([member(1)]);
    let n = 0;
    const churn: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        if (n > 10) throw new Error('sync did not give up');
        await s.redis.hSet(keys.members, '1', `x:churn-${n++}`);
        return s.deps.loadStates(event, ids);
      },
    };
    expect(await syncRosterMembersWith(EVENT, [1], churn)).toEqual({ listed: 0, removed: 0 });
    expect(n).toBe(3);
    expect(isTombstone(s.hashes.get(keys.members)?.get('1'))).toBe(true);
    expect(s.allKeysHolding('1')).toEqual([]);
  });

  // Giving up must not wipe a listing another sync made meanwhile: it clears only members the gate
  // does not list.
  it('gives up without clearing a member that another sync listed meanwhile', async () => {
    const s = setup([member(1)]);
    let n = 0;
    const churn: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        n++;
        if (n < 3) await s.redis.hSet(keys.members, '1', `x:churn-${n}`);
        else {
          // The last attempt is overtaken by a real listing, made by another sync.
          await s.redis.hSet(keys.members, '1', 'x:before-other');
          await syncRosterMembersWith(EVENT, [1], s.deps);
        }
        return s.deps.loadStates(event, ids);
      },
    };
    await syncRosterMembersWith(EVENT, [1], churn);
    expect(n).toBe(3);
    expect(rosterTeam(s.hashes.get(keys.members)?.get('1'))).toBe('Blue');
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
    expect((await s.read('points')).rows.map((r) => r.userId)).toEqual([1]);
  });

  // An ended event is still re-derived every hour: it is the net under a ban or opt-out whose own
  // sync failed, on a roster that stays public.
  it('keeps re-deriving an ended event, so a missed ban is still caught', async () => {
    const s = setup([member(1)], LIVE_NOW);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect(s.allKeysHolding('1').length).toBeGreaterThan(0);
    s.db.set(1, member(1, { eligible: false }));
    const gate = async () => Object.fromEntries(s.hashes.get(keys.members) ?? []);
    s.deps.now = () => new Date('2027-06-01T00:00:00.000Z');
    await reconcileEventRosters({ ...s.deps, gate }, [EVENT]);
    expect(s.allKeysHolding('1')).toEqual([]);
  });

  it('writes its unlistings before it reads owner points', async () => {
    const s = setup([member(1), member(2)]);
    await syncRosterMembersWith(EVENT, [1, 2], s.deps);
    s.db.set(2, member(2, { optedIn: false }));
    const order: string[] = [];
    const evalOf = s.redis.eval.bind(s.redis);
    (s.redis as { eval: typeof evalOf }).eval = async (script, args) => {
      order.push(`gate:${args.arguments[0]}`);
      return evalOf(script, args);
    };
    await syncRosterMembersWith(EVENT, [1, 2], {
      ...s.deps,
      ownerPoints: async (event, ids, now) => {
        order.push('points');
        return s.deps.ownerPoints(event, ids, now);
      },
    });
    expect(order).toContain('gate:2');
    expect(order).toContain('points');
    expect(order.indexOf('gate:2')).toBeLessThan(order.indexOf('points'));
  });

  // A sync that stalls past STALL_MS writes nothing, and derives again from fresh reads.
  it('lets no stalled sync write a stale read', async () => {
    let now = LIVE_NOW.getTime();
    const s = setup([member(1)], LIVE_NOW);
    s.deps.now = () => new Date(now);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    let calls = 0;
    const stale: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        const states = await s.deps.loadStates(event, ids);
        // The first read stalls for eleven minutes, during which the member opted out.
        if (calls++ === 0) {
          now += 11 * 60_000;
          s.db.set(1, member(1, { optedIn: false }));
        }
        return states;
      },
    };
    await syncRosterMembersWith(EVENT, [1], stale);
    expect(calls).toBe(2);
    expect(isTombstone(s.hashes.get(keys.members)?.get('1'))).toBe(true);
    expect(s.allKeysHolding('1')).toEqual([]);
  });

  it('lets a slow sync under the stall bound write, and never refuses an unlisting for a stall', async () => {
    let now = LIVE_NOW.getTime();
    const s = setup([member(1), member(2)], LIVE_NOW);
    s.deps.now = () => new Date(now);
    let calls = 0;
    const slow: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        calls++;
        now += 9 * 60_000;
        return s.deps.loadStates(event, ids);
      },
    };
    await syncRosterMembersWith(EVENT, [1], slow);
    expect(calls).toBe(1);
    expect(rosterTeam(s.hashes.get(keys.members)?.get('1'))).toBe('Blue');
    // A ban read by a sync that then stalls far past the bound still hides the member.
    s.db.set(2, member(2, { eligible: false }));
    await syncRosterMembersWith(EVENT, [2], s.deps);
    s.db.set(1, member(1, { eligible: false }));
    const stalled: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        now += 30 * 60_000;
        return s.deps.loadStates(event, ids);
      },
    };
    await syncRosterMembersWith(EVENT, [1], stalled);
    expect(isTombstone(s.hashes.get(keys.members)?.get('1'))).toBe(true);
    expect(s.allKeysHolding('1')).toEqual([]);
  });

  it('writes a different tombstone each time, even in the same millisecond', async () => {
    const s = setup([member(1, { optedIn: false })]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    const first = s.hashes.get(keys.members)?.get('1');
    await syncRosterMembersWith(EVENT, [1], s.deps);
    const second = s.hashes.get(keys.members)?.get('1');
    expect(isTombstone(first)).toBe(true);
    expect(isTombstone(second)).toBe(true);
    expect(second).not.toBe(first);
  });

  it('syncs in batches of 500, skips the hidden on a listed-only change, and survives a failing event', async () => {
    const states = Array.from({ length: 1_001 }, (_, i) => member(i + 1));
    const s = setup(states);
    const loaded: number[][] = [];
    const deps: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        if (event.name === 'broken') throw new Error('db down');
        loaded.push(ids);
        return s.deps.loadStates(event, ids);
      },
    };
    const ids = states.map((x) => x.userId);
    await syncEventRosterMembers(ids, {}, deps, [{ ...EVENT, name: 'broken' }, EVENT]);
    expect(loaded.map((ids) => ids.length)).toEqual([500, 500, 1]);
    // Now hide one: a listed-only change skips them, and the never-listed are skipped too.
    await s.redis.hSet(keys.members, '1', 'x:1');
    loaded.length = 0;
    await syncEventRosterMembers([1, 2, 5000], { onlyIfListed: true }, deps, [EVENT]);
    // Only 2, the one still listed.
    expect(loaded).toEqual([[2]]);
  });

  // Team names repeat: a gate that went Blue -> tombstone -> Blue while a sync ran must still read
  // as changed to it, or its stale unlisting would hide a member who opted back in.
  it('lets no stale unlisting hide a member who opted out and back in while it ran', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    let churned = false;
    const stale: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        // Once: its retries read fresh, as a real retry would.
        if (churned) return s.deps.loadStates(event, ids);
        churned = true;
        // This sync reads them as opted out...
        s.db.set(1, member(1, { optedIn: false }));
        const states = await s.deps.loadStates(event, ids);
        // ...the opt-out syncs, then they opt back in and that syncs too, all before it writes.
        await syncRosterMembersWith(EVENT, [1], s.deps);
        s.db.set(1, member(1));
        await syncRosterMembersWith(EVENT, [1], s.deps);
        return states;
      },
    };
    await syncRosterMembersWith(EVENT, [1], stale);
    expect(rosterTeam(s.hashes.get(keys.members)?.get('1'))).toBe('Blue');
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
  });

  it('writes a different gate value on every listing', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    const first = s.hashes.get(keys.members)?.get('1');
    await syncRosterMembersWith(EVENT, [1], s.deps);
    const second = s.hashes.get(keys.members)?.get('1');
    expect(rosterTeam(first)).toBe('Blue');
    expect(rosterTeam(second)).toBe('Blue');
    expect(second).not.toBe(first);
    expect(first).toMatch(/^Blue#[0-9a-f]{8}$/);
  });

  // A listing that lands right after this sync's tombstone writes its entries after this sync's
  // clear, so they survive. (With the clear after the tombstone, it would wipe them.)
  it('keeps the entries of a listing that lands right after its tombstone', async () => {
    const s = setup([member(1, { optedIn: false })]);
    const evalOf = s.redis.eval.bind(s.redis);
    let raced = false;
    (s.redis as { eval: typeof evalOf }).eval = async (script, args) => {
      const result = await evalOf(script, args);
      if (!raced && isTombstone(args.arguments[2])) {
        raced = true;
        // The member opts in and that sync lists them before this one clears.
        s.db.set(1, member(1));
        await syncRosterMembersWith(EVENT, [1], s.deps);
      }
      return result;
    };
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect(raced).toBe(true);
    expect(rosterTeam(s.hashes.get(keys.members)?.get('1'))).toBe('Blue');
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
    expect((await s.read('points')).rows.map((r) => r.userId)).toEqual([1]);
  });

  // The gap a clear-after-tombstone leaves: a listing reads this sync's tombstone, writes its
  // entries, the clear wipes them, then the listing's gate write succeeds. Listed, with no rows.
  it('never leaves a member listed without entries when a listing straddles an unlisting', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    s.db.set(1, member(1, { optedIn: false }));
    let entered!: () => void;
    const atGate = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let listing: Promise<unknown> | undefined;
    const evalOf = s.redis.eval.bind(s.redis);
    // The listing's gate write waits until the unlisting has finished.
    const gated = {
      ...s.redis,
      eval: async (script: string, args: EvalArgs) => {
        if (rosterTeam(args.arguments[2])) {
          entered();
          await released;
        }
        return evalOf(script, args);
      },
    };
    (s.redis as { eval: typeof evalOf }).eval = async (script, args) => {
      const result = await evalOf(script, args);
      if (!listing && isTombstone(args.arguments[2])) {
        // Right after the tombstone: the member opts back in, and that sync gets as far as its
        // gate write (entries written) before this one goes on.
        s.db.set(1, member(1));
        listing = syncRosterMembersWith(EVENT, [1], {
          ...s.deps,
          redis: gated as unknown as RosterSyncDeps['redis'],
        });
        await atGate;
      }
      return result;
    };
    await syncRosterMembersWith(EVENT, [1], s.deps);
    release();
    await listing;
    expect(rosterTeam(s.hashes.get(keys.members)?.get('1'))).toBe('Blue');
    expect((await s.read('hats')).rows.map((r) => r.userId)).toEqual([1]);
    expect((await s.read('points')).rows.map((r) => r.userId)).toEqual([1]);
  });

  // An ordinary opt-out writes once and is done: no re-derive, no give-up.
  it('unlists in one pass when nothing races it', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    s.db.set(1, member(1, { optedIn: false }));
    const loaded = vi.fn(s.deps.loadStates);
    expect(await syncRosterMembersWith(EVENT, [1], { ...s.deps, loadStates: loaded })).toEqual({
      listed: 0,
      removed: 1,
    });
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it('still hides a member when clearing their entries fails', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    s.db.set(1, member(1, { eligible: false }));
    const zRemOf = s.redis.zRem.bind(s.redis);
    let failed = false;
    (s.redis as { zRem: typeof zRemOf }).zRem = async (key, members) => {
      // Every removal fails, so all entries survive and each sort's emptiness is the gate's doing.
      failed = true;
      throw new Error(`redis blip on ${key} ${String(members)}`);
    };
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect(failed).toBe(true);
    expect(isTombstone(s.hashes.get(keys.members)?.get('1'))).toBe(true);
    // The clear failed part-way: the join-time entry is still there, and the gate hides it anyway.
    for (const key of [keys.joined('Blue'), keys.hats('Blue'), keys.points('Blue', 'preview')])
      expect(s.zsets.get(key)?.has('1')).toBe(true);
    for (const sort of ['hats', 'points', 'newest'] as const)
      expect((await s.read(sort)).rows).toEqual([]);
  });

  it('still finishes a give-up when its clear fails', async () => {
    const s = setup([member(1)]);
    let n = 0;
    const churn: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        if (n > 10) throw new Error('sync did not give up');
        await s.redis.hSet(keys.members, '1', `x:churn-${n++}`);
        return s.deps.loadStates(event, ids);
      },
    };
    let thrown = 0;
    const zRemOf = s.redis.zRem.bind(s.redis);
    (s.redis as { zRem: typeof zRemOf }).zRem = async (key, members) => {
      if (n >= 3) {
        thrown++;
        throw new Error('redis blip');
      }
      return zRemOf(key, members);
    };
    await expect(syncRosterMembersWith(EVENT, [1], churn)).resolves.toEqual({
      listed: 0,
      removed: 0,
    });
    expect(n).toBe(3);
    expect(thrown).toBeGreaterThan(0);
  });
});
