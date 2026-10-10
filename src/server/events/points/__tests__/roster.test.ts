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
const { isTombstone, rebuildEventRoster, reconcileEventRosters, syncRosterMembersWith } =
  await import('~/server/events/points/roster-sync');
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
    // Highest first; ties by member, descending, as Redis orders them under REV.
    async zRangeWithScores(key: string, start: number, stop: number) {
      const rows = [...z(key)]
        .map(([value, score]) => ({ value, score }))
        .sort((a, b) => b.score - a.score || (a.value < b.value ? 1 : -1));
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
    // The one script the roster runs: HSET only if the field still holds what the caller read. The
    // fake can only act out the script it knows, so any other text fails here, loudly. What the
    // real script does on a real Redis was measured once against redis:7 (PR body).
    async eval(script: string, { keys: [key], arguments: [field, expected, value] }: EvalArgs) {
      if (script !== LIST_IF_UNCHANGED_AS_MEASURED) throw new Error(`unexpected script: ${script}`);
      if ((h(key).get(field) ?? '') !== expected) return 0;
      h(key).set(field, value);
      return 1;
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
    expect([...s.hashes.values()].every((h) => h.size === 0)).toBe(true);
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
        await syncRosterMembersWith(EVENT, [1], s.deps, { hide: true });
        return states;
      },
    };
    await syncRosterMembersWith(EVENT, [1], stale);
    expect(s.allKeysHolding('1')).toEqual([]);
    expect((await s.read('hats')).rows).toEqual([]);
  });

  it('also stops a first opt-in still in flight, when the opt-out hides on request', async () => {
    const s = setup([member(1)]);
    const inFlight: RosterSyncDeps = {
      ...s.deps,
      loadStates: async (event, ids) => {
        const states = await s.deps.loadStates(event, ids);
        s.db.set(1, member(1, { optedIn: false }));
        await syncRosterMembersWith(EVENT, [1], s.deps, { hide: true });
        return states;
      },
    };
    await syncRosterMembersWith(EVENT, [1], inFlight);
    expect(s.allKeysHolding('1')).toEqual([]);
    expect((await s.read('newest')).rows).toEqual([]);
  });

  it('writes no tombstone for someone who was never listed, unless asked to hide them', async () => {
    const s = setup([member(1, { eligible: false })]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    expect(s.hashes.get(keys.members)?.has('1') ?? false).toBe(false);
    await syncRosterMembersWith(EVENT, [1], s.deps, { hide: true });
    expect(isTombstone(s.hashes.get(keys.members)?.get('1'))).toBe(true);
  });

  it('lists a member again once they opt back in', async () => {
    const s = setup([member(1)]);
    await syncRosterMembersWith(EVENT, [1], s.deps);
    s.db.set(1, member(1, { optedIn: false }));
    await syncRosterMembersWith(EVENT, [1], s.deps, { hide: true });
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
    await syncRosterMembersWith(EVENT, [1], s.deps, { hide: true });
    const gate = async () => Object.fromEntries(s.hashes.get(keys.members) ?? []);
    now = new Date(LIVE_NOW.getTime() + 30 * 60_000);
    await reconcileEventRosters({ ...s.deps, gate }, [EVENT]);
    expect(isTombstone(s.hashes.get(keys.members)?.get('1'))).toBe(true);
    now = new Date(LIVE_NOW.getTime() + 61 * 60_000);
    await reconcileEventRosters({ ...s.deps, gate }, [EVENT]);
    expect(s.hashes.get(keys.members)?.has('1')).toBe(false);
    expect(s.hashes.get(keys.members)?.get('2')).toBe('Blue');
  });
});
