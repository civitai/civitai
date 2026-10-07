import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCacheBuilders } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';

/**
 * `missConcurrentDuplicate` counts miss-fill lookups for an id that another fetch in the same
 * process is already looking up. It is a MEASUREMENT: every test here also asserts that the
 * duplicate lookup and its writes still happen, so the counter cannot be satisfied by a change
 * that starts coalescing.
 *
 * The redis client is a stub whose mGet always misses, so every fetch reaches lookupFn. Overlap is
 * forced with a lookupFn that parks until the test releases it.
 */

type Row = { id: number };
const KEY = 'packed:caches:test-miss-fill' as RedisKeyTemplateCache;

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function build() {
  const sets: string[] = [];
  const redis = {
    packed: {
      mGet: vi.fn(async (keys: RedisKeyTemplateCache[]) => keys.map(() => null)),
      set: vi.fn(async (key: RedisKeyTemplateCache) => {
        sets.push(key);
        return 'OK';
      }),
    },
    del: vi.fn(async () => 1),
    setNxKeepTtlWithEx: vi.fn(async () => true),
  };
  const duplicates: [string, number][] = [];
  const noop = () => undefined;
  const { createCachedArray } = createCacheBuilders({
    redis,
    defaultTtl: 300,
    metrics: {
      hit: noop,
      miss: noop,
      revalidate: noop,
      failOpenDegraded: noop,
      failOpenOriginFetch: noop,
      missConcurrentDuplicate: (name, count) => duplicates.push([name, count]),
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
  const total = () => duplicates.reduce((n, [, c]) => n + c, 0);
  /** Wait until `n` lookups are parked, i.e. every fetch so far is past its mGet. */
  const parked = (n: number) => vi.waitFor(() => expect(gates.length).toBe(n));
  return { cache, lookupFn, calls, gates, sets, duplicates, total, parked };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCachedArray — concurrent duplicate miss-fill counter', () => {
  it('two concurrent fetch([X]) count exactly 1, and BOTH still look up and write', async () => {
    const t = build();
    const a = t.cache.fetch([7]);
    const b = t.cache.fetch([7]);
    await t.parked(2);
    t.gates.forEach((g) => g.resolve());
    const [ra, rb] = await Promise.all([a, b]);

    expect(t.total()).toBe(1);
    expect(t.duplicates).toEqual([[KEY, 1]]);
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

  it('the id stays in flight while ANY holder is still looking it up', async () => {
    // A and B overlap (1). A settles while B is still parked; C then starts → still a duplicate
    // of B (2). Without per-entry holders, A's settle would drop the id and C would count 0.
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

    expect(t.total()).toBe(2);
    expect(t.lookupFn).toHaveBeenCalledTimes(3);
  });

  it('an entry older than the age cap is not counted as in flight', async () => {
    const t = build();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const stuck = t.cache.fetch([3]);
    await t.parked(1);

    // 31 s later the first lookup has still not settled.
    now.mockReturnValue(1_000_000 + 31_000);
    const later = t.cache.fetch([3]);
    await t.parked(2);
    expect(t.total()).toBe(0);

    // The stuck lookup settling must not drop `later`'s entry: a third fetch is still a duplicate.
    t.gates[0].resolve();
    await stuck;
    const third = t.cache.fetch([3]);
    await t.parked(3);
    t.gates[1].resolve();
    t.gates[2].resolve();
    await Promise.all([later, third]);

    expect(t.total()).toBe(1);
    expect(t.lookupFn).toHaveBeenCalledTimes(3);
  });

  it('at the entry cap nothing new is registered, until stale entries are swept', async () => {
    const t = build();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    // One parked fetch fills the registry to exactly its cap (50,000 ids).
    const big = t.cache.fetch(Array.from({ length: 50_000 }, (_, i) => i + 1));
    await t.parked(1);

    // At the cap: id 60001 is not registered, so a concurrent pair cannot see each other.
    const a = t.cache.fetch([60_001]);
    const b = t.cache.fetch([60_001]);
    await t.parked(3);
    t.gates[1].resolve();
    t.gates[2].resolve();
    await Promise.all([a, b]);
    expect(t.total()).toBe(0);

    // Past the age cap the big lookup's entries are stale; reaching the cap sweeps them, so the
    // next pair registers again and counts 1.
    now.mockReturnValue(1_000_000 + 31_000);
    const c = t.cache.fetch([60_002]);
    const d = t.cache.fetch([60_002]);
    await t.parked(5);
    expect(t.total()).toBe(1);
    t.gates[3].resolve();
    t.gates[4].resolve();
    await Promise.all([c, d]);

    // The big fetch looks up in 10k chunks, each parking on a new gate: release them as they come.
    let settled = false;
    void big.then(() => (settled = true));
    while (!settled) {
      t.gates.forEach((g) => g.resolve());
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(t.lookupFn).toHaveBeenCalledTimes(9); // 5 chunks + a, b, c, d
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
        missConcurrentDuplicate: sink,
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
