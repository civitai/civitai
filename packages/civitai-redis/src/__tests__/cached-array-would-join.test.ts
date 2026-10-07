import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCacheBuilders, type CacheBuilderDeps } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';

/**
 * `missWouldJoin` counts miss-fill lookups that per-process coalescing (draft PR #5488) would have
 * joined instead of running. It is a MEASUREMENT: every test here also asserts that the lookup and
 * its writes still happen, so the counter cannot be satisfied by a change that starts coalescing.
 *
 * The redis client is a stub whose mGet misses unless a test overrides one call, so every fetch
 * reaches lookupFn. Overlap is forced with a lookupFn that parks until the test releases it.
 */

type Row = { id: number };
const KEY = 'packed:caches:test-would-join' as RedisKeyTemplateCache;
const KEY2 = 'packed:caches:test-would-join-other' as RedisKeyTemplateCache;

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function build({ parkSets = false } = {}) {
  const sets: string[] = [];
  // With parkSets, every SET parks on its own gate, holding the fetch in its write phase.
  const setGates: ReturnType<typeof deferred>[] = [];
  const redis = {
    packed: {
      mGet: vi.fn(
        async (keys: RedisKeyTemplateCache[]): Promise<unknown[]> => keys.map(() => null)
      ),
      set: vi.fn(async (key: RedisKeyTemplateCache) => {
        sets.push(key);
        if (parkSets) {
          const gate = deferred();
          setGates.push(gate);
          await gate.promise;
        }
        return 'OK';
      }),
    },
    del: vi.fn(async () => 1),
    setNxKeepTtlWithEx: vi.fn(async () => true),
  };
  const joins: [string, number][] = [];
  const noop = () => undefined;
  const { createCachedArray } = createCacheBuilders({
    // The stub's mGet is not generic; the builder only ever reads records back through it.
    redis: redis as unknown as CacheBuilderDeps['redis'],
    defaultTtl: 300,
    metrics: {
      hit: noop,
      miss: noop,
      revalidate: noop,
      failOpenDegraded: noop,
      failOpenOriginFetch: noop,
      missWouldJoin: (name, count) => joins.push([name, count]),
    },
    logFailOpen: noop,
    logRefreshError: noop,
    log: noop,
    clearByPattern: async () => undefined,
  });

  // Each call parks on its own gate; `calls` records the ids each call was asked for.
  const gates: ReturnType<typeof deferred>[] = [];
  const calls: number[][] = [];
  const lookupFn = vi.fn(async (ids: number[]) => {
    calls.push([...ids]);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    return Object.fromEntries(ids.map((id) => [id, { id }])) as Record<string, Row>;
  });
  const cache = createCachedArray<Row>({ key: KEY, idKey: 'id', lookupFn, ttl: 60 });
  // A second cache from the SAME builders, to pin that the registry is per cache.
  const otherCache = createCachedArray<Row>({ key: KEY2, idKey: 'id', lookupFn, ttl: 60 });
  const total = () => joins.reduce((n, [, c]) => n + c, 0);
  /** Wait until `n` lookups are parked, i.e. every fetch so far is past its mGet. */
  const parked = (n: number) => vi.waitFor(() => expect(gates.length).toBe(n));
  /** Make the NEXT fetch's mGet return this stored value for every key it reads. */
  const nextRead = (value: object) =>
    redis.packed.mGet.mockImplementationOnce(async (keys: RedisKeyTemplateCache[]) =>
      keys.map(() => value)
    );
  return {
    cache,
    otherCache,
    lookupFn,
    calls,
    gates,
    setGates,
    sets,
    joins,
    total,
    parked,
    nextRead,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCachedArray — would-be-join counter (mirrors #5488)', () => {
  it('two concurrent fetch([X]) count exactly 1, and BOTH still look up and write', async () => {
    const t = build();
    const a = t.cache.fetch([7]);
    const b = t.cache.fetch([7]);
    await t.parked(2);
    t.gates.forEach((g) => g.resolve());
    const [ra, rb] = await Promise.all([a, b]);

    expect(t.total()).toBe(1);
    expect(t.joins).toEqual([[KEY, 1]]);
    // Behaviour-neutral: two lookups, two SETs, both callers get the row.
    expect(t.lookupFn).toHaveBeenCalledTimes(2);
    expect(t.calls).toEqual([[7], [7]]);
    expect(t.sets).toEqual([`${KEY}:7`, `${KEY}:7`]);
    expect(ra).toEqual([{ id: 7 }]);
    expect(rb).toEqual([{ id: 7 }]);
  });

  it('overlapping batches [1,2] + [2,3] count only the shared id', async () => {
    const t = build();
    const a = t.cache.fetch([1, 2]);
    const b = t.cache.fetch([2, 3]);
    await t.parked(2);
    t.gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(t.total()).toBe(1);
    expect(t.calls).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect([...t.sets].sort()).toEqual([`${KEY}:1`, `${KEY}:2`, `${KEY}:2`, `${KEY}:3`]);
  });

  it("a fetch overlapping the originator's WRITE phase still counts", async () => {
    const t = build({ parkSets: true });
    const a = t.cache.fetch([6]);
    await t.parked(1);
    t.gates[0].resolve();
    // A's lookup is done; it is now parked in its SET.
    await vi.waitFor(() => expect(t.setGates.length).toBe(1));

    const b = t.cache.fetch([6]);
    await t.parked(2);
    t.gates[1].resolve();
    await vi.waitFor(() => expect(t.setGates.length).toBe(2));
    t.setGates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(t.total()).toBe(1);
    expect(t.sets).toEqual([`${KEY}:6`, `${KEY}:6`]);
  });

  it('the registry is per cache: the same id in two caches is not a join', async () => {
    const t = build();
    const a = t.cache.fetch([7]);
    const b = t.otherCache.fetch([7]);
    await t.parked(2);
    t.gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(t.total()).toBe(0);
    expect(t.lookupFn).toHaveBeenCalledTimes(2);
  });

  it('sequential fetches of the same id count 0 (the entry is removed once the fill settles)', async () => {
    const t = build();
    const first = t.cache.fetch([5]);
    await t.parked(1);
    t.gates[0].resolve();
    await first;

    const second = t.cache.fetch([5]);
    await t.parked(2);
    t.gates[1].resolve();
    await second;

    expect(t.total()).toBe(0);
    expect(t.lookupFn).toHaveBeenCalledTimes(2);
    expect(t.sets).toEqual([`${KEY}:5`, `${KEY}:5`]);
  });

  it('a FAILING lookup removes its entry: a later concurrent pair counts 1, not 2', async () => {
    const t = build();
    const failing = t.cache.fetch([9]);
    await t.parked(1);
    t.gates[0].reject(new Error('db down'));
    await expect(failing).rejects.toThrow('db down');
    expect(t.total()).toBe(0);

    const a = t.cache.fetch([9]);
    const b = t.cache.fetch([9]);
    await t.parked(3);
    t.gates[1].resolve();
    t.gates[2].resolve();
    await Promise.all([a, b]);

    expect(t.total()).toBe(1);
    expect(t.lookupFn).toHaveBeenCalledTimes(3);
  });

  it('a would-be joiner does not register: once the originator settles, a later fetch is not a join', async () => {
    // A originates, B would join A. A settles while B is still filling; C then starts. #5488 would
    // have had B wait on A, so nothing is in flight for C to join.
    const t = build();
    const a = t.cache.fetch([4]);
    const b = t.cache.fetch([4]);
    await t.parked(2);
    t.gates[0].resolve();
    await a;

    const c = t.cache.fetch([4]);
    await t.parked(3);
    t.gates[1].resolve();
    t.gates[2].resolve();
    await Promise.all([b, c]);

    expect(t.total()).toBe(1);
    expect(t.lookupFn).toHaveBeenCalledTimes(3);
  });

  it('the join window is 10 s: joined just under it, not at it (the entry is replaced)', async () => {
    const t = build();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const stuck = t.cache.fetch([3]);
    await t.parked(1);

    now.mockReturnValue(1_000_000 + 9_999);
    const inside = t.cache.fetch([3]);
    await t.parked(2);
    expect(t.total()).toBe(1);

    now.mockReturnValue(1_000_000 + 10_000);
    const atLimit = t.cache.fetch([3]);
    await t.parked(3);
    expect(t.total()).toBe(1);

    // The stuck originator settling must not drop the replacement registered at +10 s: a fetch
    // inside the replacement's window still counts.
    t.gates[0].resolve();
    await stuck;
    now.mockReturnValue(1_000_000 + 10_001);
    const afterSettle = t.cache.fetch([3]);
    await t.parked(4);
    expect(t.total()).toBe(2);

    for (const i of [1, 2, 3]) t.gates[i].resolve();
    await Promise.all([inside, atLimit, afterSettle]);
    expect(t.lookupFn).toHaveBeenCalledTimes(4);
  });

  it('a debounce-marker id never joins', async () => {
    const t = build();
    // Markers outside the 10 s debounce window (an hour old), so both fetches look up AND write.
    const oldMarker = { id: 2, debounce: true, cachedAt: new Date(Date.now() - 3_600_000) };
    t.nextRead(oldMarker);
    const a = t.cache.fetch([2]);
    t.nextRead(oldMarker);
    const b = t.cache.fetch([2]);
    await t.parked(2);
    t.gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(t.total()).toBe(0);
    expect(t.lookupFn).toHaveBeenCalledTimes(2);
    expect(t.sets).toEqual([`${KEY}:2`, `${KEY}:2`]);
  });

  it('a debounce-marker id outside the debounce window still registers for later fetches', async () => {
    const t = build();
    t.nextRead({ id: 2, debounce: true, cachedAt: new Date(Date.now() - 3_600_000) });
    const a = t.cache.fetch([2]);
    const b = t.cache.fetch([2]); // plain miss
    await t.parked(2);
    t.gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(t.total()).toBe(1);
  });

  it('an id inside the debounce window (dontCache) is not registered, so nothing joins it', async () => {
    const t = build();
    t.nextRead({ id: 2, debounce: true, cachedAt: new Date() });
    const a = t.cache.fetch([2]);
    const b = t.cache.fetch([2]); // plain miss
    await t.parked(2);
    t.gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(t.total()).toBe(0);
    expect(t.lookupFn).toHaveBeenCalledTimes(2);
    // Behaviour unchanged: the in-window fetch does not cache, the plain miss does.
    expect(t.sets).toEqual([`${KEY}:2`]);
  });

  it('bust() detaches an in-flight miss-fill: a fetch after it is not a join', async () => {
    const t = build();
    const a = t.cache.fetch([8]);
    await t.parked(1);
    await t.cache.bust(8);
    const b = t.cache.fetch([8]);
    await t.parked(2);
    t.gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(t.total()).toBe(0);
    expect(t.lookupFn).toHaveBeenCalledTimes(2);
  });

  it('refresh() detaches an in-flight miss-fill: a fetch after it is not a join', async () => {
    const t = build();
    const a = t.cache.fetch([8]);
    await t.parked(1);
    const refreshed = t.cache.refresh(8);
    await t.parked(2);
    t.gates[1].resolve();
    await refreshed;
    const b = t.cache.fetch([8]);
    await t.parked(3);
    t.gates.forEach((g) => g.resolve());
    await Promise.all([a, b]);

    expect(t.total()).toBe(0);
  });

  it('a throwing metrics sink does not fail the fetch', async () => {
    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id }]))
    );
    const sink = vi.fn(() => {
      throw new Error('sink broke');
    });
    const gate = deferred();
    const slowLookup = vi.fn(async (ids: number[]) => {
      await gate.promise;
      return lookupFn(ids);
    });
    const { createCachedArray } = createCacheBuilders({
      redis: {
        packed: { mGet: async (keys) => keys.map(() => null), set: async () => 'OK' },
        del: async () => 1,
        setNxKeepTtlWithEx: async () => true,
      },
      defaultTtl: 300,
      metrics: {
        hit: () => undefined,
        miss: () => undefined,
        revalidate: () => undefined,
        failOpenDegraded: () => undefined,
        failOpenOriginFetch: () => undefined,
        missWouldJoin: sink,
      },
      logFailOpen: () => undefined,
      logRefreshError: () => undefined,
      log: () => undefined,
      clearByPattern: async () => undefined,
    });
    const cache = createCachedArray<Row>({ key: KEY, idKey: 'id', lookupFn: slowLookup });
    const a = cache.fetch([1]);
    const b = cache.fetch([1]);
    await vi.waitFor(() => expect(slowLookup).toHaveBeenCalledTimes(2));
    gate.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual([[{ id: 1 }], [{ id: 1 }]]);
    // Reachability: the throwing sink really ran.
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
