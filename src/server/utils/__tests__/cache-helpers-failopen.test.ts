import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fail-open coverage for createCachedArray / createCachedObject `.fetch`.
 *
 * Background (PR #2611 + this PR): a node-redis CLUSTER (cache) command can wedge — the
 * #2556 socketTimeout (~10s) / #2611 command-deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS)
 * now make a stuck read REJECT instead of hanging 125s. But the cachedArray read path had
 * NO try/catch around its `redis.packed.mGet`, so that reject propagated → TRPCError → 500
 * (a 68-min 500 spike on two wedged pods). These tests pin the contract that the read now
 * fails OPEN to a single-flighted origin (lookupFn) fetch — mirroring fetchThroughCache.
 *
 * The redis client is mocked so we can force a read rejection deterministically. The fail-
 * open logger is stubbed to a no-op (it's fire-and-forget Axiom/Loki I/O, not under test).
 */

// Controllable fake CLUSTER redis client. mGet can be flipped to reject to simulate a
// wedged cluster command (socketTimeout / command-deadline reject).
const mGetMock = vi.fn();
const setMock = vi.fn().mockResolvedValue(undefined);
const setNxMock = vi.fn().mockResolvedValue(true);
const delMock = vi.fn().mockResolvedValue(undefined);

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: {
      mGet: (...args: unknown[]) => mGetMock(...args),
      set: (...args: unknown[]) => setMock(...args),
    },
    setNxKeepTtlWithEx: (...args: unknown[]) => setNxMock(...args),
    del: (...args: unknown[]) => delMock(...args),
  },
  sysRedis: {},
  REDIS_KEYS: { CACHE_LOCKS: 'caches:lock' },
}));

// Keep the fail-open logger inert (it's fire-and-forget Axiom/Loki, not under test).
vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));

import { createCachedArray, createCachedObject } from '~/server/utils/cache-helpers';

type Row = { id: number; name: string };

beforeEach(() => {
  mGetMock.mockReset();
  setMock.mockClear();
  setNxMock.mockClear();
  delMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCachedArray.fetch — Redis read fail-open', () => {
  it('returns the ORIGIN (lookupFn) result instead of throwing when the redis read rejects', async () => {
    // Simulate a wedged cluster command: the read rejects (what the #2611 deadline does).
    mGetMock.mockRejectedValue(new Error('redis cluster command timed out after 3000ms'));

    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );

    const cache = createCachedArray<Row>({ key: 'test:arr' as never, idKey: 'id', lookupFn });

    // BEFORE this fix this would reject (→ TRPCError → 500). It must now resolve to the
    // origin result (degraded slow-200) instead.
    const result = await cache.fetch([1, 2, 3]);

    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(result.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(result.find((r) => r.id === 2)?.name).toBe('db-2');
  });

  it('single-flights the fail-open origin fetch across concurrent requests for the same id-set', async () => {
    mGetMock.mockRejectedValue(new Error('redis cluster command timed out after 3000ms'));

    // A slow lookupFn so the concurrent calls overlap in time and MUST share one promise.
    let resolveLookup: (v: Record<string, Row>) => void;
    const lookupGate = new Promise<Record<string, Row>>((r) => (resolveLookup = r));
    const lookupFn = vi.fn(() => lookupGate);

    const cache = createCachedArray<Row>({ key: 'test:sf' as never, idKey: 'id', lookupFn });

    // Fire 5 concurrent fetches for the same id-set while redis is wedged.
    const inFlight = [cache.fetch([10, 11]), cache.fetch([10, 11]), cache.fetch([11, 10]), cache.fetch([10, 11]), cache.fetch([10, 11])];

    // Let microtasks flush so all 5 reach the fail-open single-flight before it resolves.
    await Promise.resolve();
    await Promise.resolve();

    resolveLookup!({ 10: { id: 10, name: 'a' }, 11: { id: 11, name: 'b' } });
    const results = await Promise.all(inFlight);

    // The stampede guard: ONE origin call serves all 5 concurrent requests (incl. the
    // reversed [11,10] id order, which the sorted single-flight key collapses to the same).
    expect(lookupFn).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.map((x) => x.id).sort((a, b) => a - b)).toEqual([10, 11]);
    }
  });

  it('coalesces OVERLAPPING id-sets at the id level — the shared ids are NOT double-fetched', async () => {
    // The audit gap this guards: hot callers (imageMetaCache / tagIdsForImagesCache) pass
    // per-feed-page id lists. Under a full wedge (EVERY mGet rejects) the per-id-SET single-
    // flight does NOT collapse [1,2,3] vs [2,3,4] (distinct sets) — so without per-ID
    // coalescing each page = a full independent DB fetch, flooding the DB ∝ pages. With it,
    // the overlap {2,3} is fetched ONCE; total distinct ids fetched = {1,2,3,4}, not 3+3=6.
    mGetMock.mockRejectedValue(new Error('redis cluster command timed out after 3000ms'));

    // Gate the first batched DB call so the second request enters fail-open while the first's
    // per-id promises (for 1,2,3) are still in flight — that's what lets it reuse 2 and 3.
    let releaseFirst: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const fetchedIdBatches: number[][] = [];
    let callCount = 0;
    const lookupFn = vi.fn(async (ids: number[]) => {
      fetchedIdBatches.push([...ids]);
      callCount++;
      if (callCount === 1) await firstGate; // hold the first DB call open
      return Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<
        string,
        Row
      >;
    });

    const cache = createCachedArray<Row>({ key: 'test:overlap' as never, idKey: 'id', lookupFn });

    const first = cache.fetch([1, 2, 3]); // registers per-id in-flight for 1,2,3, awaits firstGate
    // Let the first request register its per-id in-flight entries before the second starts.
    await Promise.resolve();
    await Promise.resolve();
    const second = cache.fetch([2, 3, 4]); // should reuse 2,3 in-flight, only originate 4
    // Let the second request reach its (only) DB call for the missing id (4).
    await Promise.resolve();
    await Promise.resolve();

    releaseFirst!();
    const [r1, r2] = await Promise.all([first, second]);

    // Every distinct id fetched across ALL lookupFn calls — must be exactly {1,2,3,4} (the
    // overlap counted once), proving per-id dedup. Not 6 (3+3), which is the unbounded flood.
    const allFetched = new Set(fetchedIdBatches.flat());
    expect([...allFetched].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(fetchedIdBatches.flat()).toHaveLength(4); // no id fetched twice

    // Correctness: each request still gets ALL of its requested ids back.
    expect(r1.map((x) => x.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(r2.map((x) => x.id).sort((a, b) => a - b)).toEqual([2, 3, 4]);
    expect(r2.find((x) => x.id === 2)?.name).toBe('db-2'); // the reused-from-first value
  });

  it('does NOT swallow a genuine lookupFn (origin/DB) error — it must still propagate', async () => {
    mGetMock.mockRejectedValue(new Error('redis cluster command timed out after 3000ms'));
    const lookupFn = vi.fn(async () => {
      throw new Error('real DB failure');
    });

    const cache = createCachedArray<Row>({ key: 'test:dberr' as never, idKey: 'id', lookupFn });

    // A real origin error is NOT a redis error — it must surface, not be turned into a 200.
    await expect(cache.fetch([1])).rejects.toThrow(/real DB failure/);
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });

  it('serves results normally (no origin fetch for hits) when the redis read succeeds', async () => {
    // Healthy read returns a cached, fresh value → no lookupFn call for that id.
    const cachedAt = new Date(); // fresh
    mGetMock.mockResolvedValue([{ id: 5, name: 'cached', cachedAt }]);
    const lookupFn = vi.fn(async () => ({}) as Record<string, Row>);

    const cache = createCachedArray<Row>({ key: 'test:hit' as never, idKey: 'id', lookupFn });
    const result = await cache.fetch([5]);

    expect(lookupFn).not.toHaveBeenCalled();
    expect(result).toEqual([{ id: 5, name: 'cached' }]);
  });
});

describe('createCachedObject.fetch — Redis read fail-open', () => {
  it('returns the origin result keyed by id (not throws) when the redis read rejects', async () => {
    mGetMock.mockRejectedValue(new Error('redis cluster command timed out after 3000ms'));
    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );

    const cache = createCachedObject<Row>({ key: 'test:obj' as never, idKey: 'id', lookupFn });
    const result = await cache.fetch([7, 8]);

    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(result['7']?.name).toBe('db-7');
    expect(result['8']?.name).toBe('db-8');
  });
});
