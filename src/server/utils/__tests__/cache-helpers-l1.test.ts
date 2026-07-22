import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the opt-in per-pod L1 cache in createCachedArray / createCachedObject.
 *
 * Background: on the image-feed hydration path `redis.packed.mGet` decomposes into
 * per-id GETs (no cross-slot MGET), so N images fan out to N Redis commands, each
 * routed through cluster-routing-retry individually — the dominant driver of
 * api-heavy's Redis command volume + cluster-slot churn. The `localTtl` opt-in adds a
 * bounded in-process LRU in front of the Redis per-id cache: an L1 hit skips the
 * ENTIRE Redis fan-out for that id.
 *
 * These tests pin the contract:
 *  - an L1 hit does NOT touch Redis (mGet) or the origin (lookupFn);
 *  - an L1 miss falls through to the existing Redis path and backfills L1;
 *  - the L1 value is byte-identical to the Redis path's return;
 *  - the TTL expires and re-fetches;
 *  - the LRU is bounded (evicts, no unbounded growth);
 *  - `notFound` ids are never L1-cached (positive-only — no stale-miss pinning);
 *  - a cache WITHOUT `localTtl` is untouched (no L1 layer at all);
 *  - a caller mutating its returned object cannot corrupt the shared L1 instance;
 *  - the lruCache hit/miss counters are emitted for measurability.
 *
 * The redis client + prom counters are mocked (mirrors cache-helpers-failopen.test.ts)
 * so we can assert exactly which layer served each id.
 */

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
  REDIS_KEYS: { CACHE_LOCKS: 'caches:lock', TAG: 'caches:tag' },
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));

// vi.hoisted so the inc spies exist before the (hoisted) vi.mock factory references
// them — lets us assert the lruCache hit/miss observability wiring.
const { hitInc, missInc } = vi.hoisted(() => ({
  hitInc: vi.fn(),
  missInc: vi.fn(),
}));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: hitInc },
  cacheMissCounter: { inc: missInc },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));

import { createCachedArray, createCachedObject } from '~/server/utils/cache-helpers';

type Row = { id: number; name: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Count how many lruCache-typed hits/misses were recorded (across all calls).
const lruHits = () =>
  hitInc.mock.calls
    .filter((c) => (c[0] as { cache_type?: string })?.cache_type === 'lruCache')
    .reduce((s, c) => s + ((c[1] as number) ?? 1), 0);
const lruMisses = () =>
  missInc.mock.calls
    .filter((c) => (c[0] as { cache_type?: string })?.cache_type === 'lruCache')
    .reduce((s, c) => s + ((c[1] as number) ?? 1), 0);

beforeEach(() => {
  // Empty read → every id is a Redis miss; lookupFn (origin) fills it, then it is
  // written back (setMock) and backfilled into L1.
  mGetMock.mockReset().mockResolvedValue([]);
  setMock.mockClear().mockResolvedValue(undefined);
  setNxMock.mockClear().mockResolvedValue(true);
  delMock.mockClear().mockResolvedValue(undefined);
  hitInc.mockClear();
  missInc.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const makeLookup = () =>
  vi.fn(
    async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
  );

describe('createCachedArray L1 — hit skips the Redis fan-out', () => {
  it('serves a warmed id from L1 without calling mGet or lookupFn', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1hit' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 5,
    });

    // Warm: first fetch is a full miss → Redis read + origin + backfill L1.
    const first = await cache.fetch([1]);
    expect(mGetMock).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(first).toEqual([{ id: 1, name: 'db-1' }]);

    mGetMock.mockClear();
    lookupFn.mockClear();

    // Warm hit: neither Redis nor the origin is touched.
    const second = await cache.fetch([1]);
    expect(mGetMock).not.toHaveBeenCalled();
    expect(lookupFn).not.toHaveBeenCalled();
    expect(second).toEqual([{ id: 1, name: 'db-1' }]);
    expect(lruHits()).toBeGreaterThanOrEqual(1);
  });

  it('only the L1-miss ids reach Redis on a partial hit; result merges both', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1partial' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 5,
    });

    await cache.fetch([1]); // warm id 1 into L1
    mGetMock.mockClear();
    lookupFn.mockClear();

    const result = await cache.fetch([1, 2]); // 1 = L1 hit, 2 = miss
    // Redis + origin saw ONLY the miss (id 2), never the warmed id 1.
    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledWith([2]);
    const mGetKeys = (mGetMock.mock.calls[0]?.[0] as string[]) ?? [];
    expect(mGetKeys).toEqual(['test:l1partial:2']);
    expect(result.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(result.find((r) => r.id === 1)?.name).toBe('db-1');
    expect(result.find((r) => r.id === 2)?.name).toBe('db-2');
  });
});

describe('createCachedArray L1 — byte-identical + TTL + bounded', () => {
  it('the L1 value is byte-identical to the Redis-path return', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1identical' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 5,
    });

    const fromRedisPath = await cache.fetch([42]);
    const fromL1 = await cache.fetch([42]);
    expect(fromL1).toEqual(fromRedisPath);
    // No internal bookkeeping (cachedAt) leaks into the L1-served value.
    expect(fromL1[0]).not.toHaveProperty('cachedAt');
  });

  it('re-fetches after the L1 TTL expires', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1ttl' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 0.05, // 50ms
    });

    await cache.fetch([1]); // warm
    mGetMock.mockClear();
    lookupFn.mockClear();

    await sleep(80); // let the L1 entry expire

    await cache.fetch([1]); // expired → falls through to Redis again
    expect(mGetMock).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });

  it('is BYTE-bounded: exceeding localMaxBytes evicts LRU to keep the heap footprint capped', async () => {
    // Values ~2.1KB each (1000-char name). Budget 5000 bytes → ~2 fit; the entry
    // cap (localMax) is high so the BYTE cap is the binding constraint.
    const big = 'x'.repeat(1000);
    const lookupFn = vi.fn(
      async (ids: number[]) =>
        Object.fromEntries(ids.map((id) => [id, { id, name: `${big}-${id}` }])) as Record<string, Row>
    );
    const cache = createCachedArray<Row>({
      key: 'test:l1bytes' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
      localMax: 10000, // high — byte cap binds first
      localMaxBytes: 5000,
    });

    await cache.fetch([1]); // L1 ~2.1KB
    await cache.fetch([2]); // L1 ~4.2KB
    await cache.fetch([3]); // would be ~6.3KB > 5000 → evicts LRU (id 1) to fit
    mGetMock.mockClear().mockResolvedValue([]);
    lookupFn.mockClear();

    await cache.fetch([1]); // id 1 was byte-evicted → must re-fetch
    expect(mGetMock).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledWith([1]);

    await cache.fetch([3]); // id 3 still resident → served from L1 (no new origin call)
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });

  it('never stores a single value larger than localMaxBytes (falls through to Redis, no throw)', async () => {
    const huge = 'y'.repeat(10000); // ~20KB, larger than the 4KB budget
    const lookupFn = vi.fn(
      async (ids: number[]) =>
        Object.fromEntries(ids.map((id) => [id, { id, name: `${huge}-${id}` }])) as Record<string, Row>
    );
    const cache = createCachedArray<Row>({
      key: 'test:l1huge' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
      localMaxBytes: 4000,
    });

    const first = await cache.fetch([1]); // stored? no — value > budget
    expect(first[0].name).toBe(`${huge}-1`); // still returned correctly
    mGetMock.mockClear().mockResolvedValue([]);

    await cache.fetch([1]); // not in L1 → back to Redis (no crash)
    expect(mGetMock).toHaveBeenCalledTimes(1);
  });

  it('is bounded: exceeding localMax evicts the LRU entry (no unbounded growth)', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1bound' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
      localMax: 2,
    });

    await cache.fetch([1]); // L1: {1}
    await cache.fetch([2]); // L1: {1,2}
    await cache.fetch([3]); // L1: {2,3} — id 1 evicted (max 2)
    mGetMock.mockClear();
    lookupFn.mockClear();

    await cache.fetch([1]); // evicted → must re-fetch from Redis/origin
    expect(mGetMock).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledWith([1]);

    await cache.fetch([3]); // still resident → served from L1
    // (id 3 fetch above must NOT have added a second origin call for id 3)
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });
});

describe('createCachedArray L1 — positive-only (no negative pinning)', () => {
  it('never L1-caches a notFound id; it re-checks Redis each time', async () => {
    // id 2 never has a DB row → notFound. mGet stays empty (no positive redis entry).
    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(
        ids.filter((id) => id !== 2).map((id) => [id, { id, name: `db-${id}` }])
      ) as Record<string, Row>
    );
    const cache = createCachedArray<Row>({
      key: 'test:l1nf' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
    });

    const first = await cache.fetch([2]);
    expect(first).toEqual([]); // notFound → omitted
    mGetMock.mockClear();

    // Because the negative was NOT pinned in L1, the id still consults Redis — so a
    // later create (once the Redis notFound marker clears) resolves without waiting
    // out an L1 TTL.
    await cache.fetch([2]);
    expect(mGetMock).toHaveBeenCalledTimes(1);
  });
});

describe('createCachedArray — WITHOUT localTtl (excluded caches, e.g. metrics)', () => {
  it('never installs an L1 layer: every fetch hits Redis, no lruCache metrics', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:nol1' as never,
      idKey: 'id',
      lookupFn,
      // no localTtl
    });

    await cache.fetch([1]);
    await cache.fetch([1]); // would be an L1 hit IF L1 existed
    expect(mGetMock).toHaveBeenCalledTimes(2); // both went to Redis
    expect(lruHits()).toBe(0);
    expect(lruMisses()).toBe(0);
  });
});

describe('createCachedArray L1 — shared-instance isolation', () => {
  it('a caller mutating its returned object does not corrupt the L1 copy', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1iso' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
    });

    const first = await cache.fetch([1]);
    first[0].name = 'MUTATED'; // caller mutates its copy
    mGetMock.mockClear();
    lookupFn.mockClear();

    const second = await cache.fetch([1]); // served from L1
    expect(mGetMock).not.toHaveBeenCalled(); // still an L1 hit
    expect(second[0].name).toBe('db-1'); // NOT corrupted by the earlier mutation
  });
});

describe('createCachedArray L1 — mirrors the Redis-write skip (dontCache/debounce)', () => {
  it('does NOT L1-cache a freshly-busted (debounce) id so the debounce/replica-lag guard survives', async () => {
    // Redis returns a debounce marker with a RECENT cachedAt → the id is treated as
    // `dontCache` (within debounceTime): served from origin (dbRead) but deliberately
    // NOT written back to Redis. The L1 must skip it too, else it would pin the
    // possibly replica-lagged read for localTtl.
    mGetMock.mockResolvedValue([{ id: 1, debounce: true, cachedAt: new Date() }]);
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1debounce' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
    });

    const first = await cache.fetch([1]);
    expect(first).toEqual([{ id: 1, name: 'db-1' }]); // served from origin
    mGetMock.mockClear();

    // Not pinned in L1 → the next read still consults Redis (would be an L1 hit if we
    // had wrongly cached the debounced value).
    await cache.fetch([1]);
    expect(mGetMock).toHaveBeenCalledTimes(1);
  });
});

describe('createCachedArray L1 — self-pod invalidation', () => {
  it('bust() drops the id from THIS pod L1 (no self-pod stale serve)', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1bust' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
    });

    await cache.fetch([1]); // warm L1
    mGetMock.mockClear().mockResolvedValue([]);
    lookupFn.mockClear();

    await cache.bust(1); // must delete id 1 from L1 (bust == invalidate when SWR on)

    mGetMock.mockClear().mockResolvedValue([]);
    await cache.fetch([1]); // L1 was dropped → back to Redis
    expect(mGetMock).toHaveBeenCalledTimes(1);
  });

  it('refresh() drops the id from THIS pod L1', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedArray<Row>({
      key: 'test:l1refresh' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
    });

    await cache.fetch([1]); // warm L1
    await cache.refresh(1); // re-fetches primary + drops L1

    mGetMock.mockClear().mockResolvedValue([]);
    await cache.fetch([1]);
    expect(mGetMock).toHaveBeenCalledTimes(1); // served from Redis, not stale L1
  });
});

describe('createCachedObject L1 — keyed Record served from L1', () => {
  it('returns the same keyed Record whether served from Redis or L1', async () => {
    const lookupFn = makeLookup();
    const cache = createCachedObject<Row>({
      key: 'test:l1obj' as never,
      idKey: 'id',
      lookupFn,
      localTtl: 60,
    });

    const fromRedis = await cache.fetch([1, 2]);
    mGetMock.mockClear();
    lookupFn.mockClear();

    const fromL1 = await cache.fetch([1, 2]);
    expect(mGetMock).not.toHaveBeenCalled();
    expect(fromL1).toEqual(fromRedis);
    expect(Object.keys(fromL1).sort()).toEqual(['1', '2']);
    expect(fromL1['2'].name).toBe('db-2');
  });
});
