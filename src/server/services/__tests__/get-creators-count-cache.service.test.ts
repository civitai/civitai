import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tests for the getCreators count path (perf fixes for the slow /api/v1/creators).
//
// Two perf fixes coexist here, split by whether `query` (username search) is set:
//
//  1. NO-QUERY BROWSE path — cached exact count. EXPLAIN ANALYZE proved the
//     `dbRead.user.count({ where })` in the `count:true` branch dominates the
//     endpoint (~1174ms — it scans the whole ~900k-row Model table). The
//     total-creators count is a slowly-moving aggregate, so it's wrapped in
//     `fetchThroughCache` (fail-open) keyed only by `excludeIds` (the only
//     varying part of `where` on the browse path).
//
//  2. QUERY (username-search) path — the exact COUNT is DROPPED entirely. The
//     search count is pathological (`username LIKE '%q%'` ∩ `models: { some }` →
//     full Model-table scan → ~90k nested-loop probes into User, ~800ms–1.4s on
//     EVERY keystroke request) and uncacheable (user-controlled `query`, no
//     schema max → unbounded keyspace). Instead we over-fetch `take + 1` rows and
//     return a `hasMore` boolean; the controller maps that to lower-bound
//     pagination metadata. NO `dbRead.user.count` runs on the query path.
//
// These tests exercise:
//   - no-query MISS  → runs dbRead.user.count once and returns the value
//   - no-query HIT   → same excludeIds does NOT call dbRead.user.count again
//   - WITH query     → count is NEVER run; take+1 hasMore probe drives pagination
//   - take+1 boundary → exactly `take` rows ⇒ hasMore=false; `take+1` ⇒
//     hasMore=true, items trimmed back to `take`
//   - key VARIES by excludeIds (different inputs → separate counts)
//   - count:false/unset → never touches the count cache
//   - cache-throws fallback → a fetchThroughCache throw still returns a correct
//     count via the inline fallback (no 500)

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    user: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
      count: vi.fn(async (..._a: unknown[]): Promise<number> => 0),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));

// user.service reaches into the user-preferences module surface at import time;
// stub it the same way the sibling idempotent tests do so the module loads.
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenModels: { refreshCache: vi.fn(async () => undefined) },
  HiddenModels3D: { refreshCache: vi.fn(async () => undefined) },
  HiddenUsers: { refreshCache: vi.fn(async () => undefined) },
  HiddenImages: { refreshCache: vi.fn(async () => undefined) },
  HiddenTags: { refreshCache: vi.fn(async () => undefined) },
  BlockedUsers: { refreshCache: vi.fn(async () => undefined), getCached: vi.fn(async () => []) },
  BlockedByUsers: { refreshCache: vi.fn(async () => undefined) },
  ImplicitHiddenImages: { refreshCache: vi.fn(async () => undefined) },
  toggleHidden: vi.fn(async () => ({ added: [], removed: [] })),
}));

// Mock fetchThroughCache with a real in-memory cache keyed by the cache key, so
// we can deterministically assert MISS-runs-once / HIT-skips / key-varies without
// a live Redis. This mirrors fetchThroughCache's contract: on a miss it runs
// fetchFn() and stores the result under `key`; on a hit it returns the stored
// value WITHOUT calling fetchFn. (TTL is ignored here — these tests assert keying
// + invocation behavior, not expiry.) The real helper is independently fail-open
// (see cache-helpers.ts); the failOpen test below installs an implementation that
// reproduces that contract.
const { cacheStore, fetchThroughCacheImpl } = vi.hoisted(() => {
  const cacheStore = new Map<string, unknown>();
  return {
    cacheStore,
    // mutable holder so individual tests can swap in a fail-open implementation
    fetchThroughCacheImpl: {
      fn: async (key: string, fetchFn: () => Promise<unknown>) => {
        if (cacheStore.has(key)) return cacheStore.get(key);
        const value = await fetchFn();
        cacheStore.set(key, value);
        return value;
      },
    },
  };
});

// Override ONLY fetchThroughCache; keep every other real export (createCachedArray,
// createCachedObject, …) so the transitive import graph (resource-data caches, etc.)
// still loads. This module's cache factories build lazily, so importing the real
// ones is safe — they never touch Redis at module load.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/cache-helpers')>();
  return {
    ...actual,
    fetchThroughCache: (key: string, fetchFn: () => Promise<unknown>, _opts?: unknown) =>
      fetchThroughCacheImpl.fn(key, fetchFn),
  };
});

import { getCreators } from '~/server/services/user.service';

const select = { username: true, image: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  // restore the default caching implementation between tests
  fetchThroughCacheImpl.fn = async (key: string, fetchFn: () => Promise<unknown>) => {
    if (cacheStore.has(key)) return cacheStore.get(key);
    const value = await fetchFn();
    cacheStore.set(key, value);
    return value;
  };
});

describe('getCreators — count cache', () => {
  it('MISS (no query): runs dbRead.user.count once and returns the value', async () => {
    mockDb.user.count.mockResolvedValueOnce(123);

    const result = await getCreators({ select, count: true, excludeIds: [-1] });

    expect(result.count).toBe(123);
    expect(mockDb.user.count).toHaveBeenCalledTimes(1);
  });

  it('HIT (no query): second call with same excludeIds does NOT re-run dbRead.user.count', async () => {
    mockDb.user.count.mockResolvedValue(50);

    const first = await getCreators({ select, count: true, excludeIds: [-1] });
    const second = await getCreators({ select, count: true, excludeIds: [-1] });

    expect(first.count).toBe(50);
    expect(second.count).toBe(50);
    // count() ran exactly once across the two calls — the second was a cache hit.
    expect(mockDb.user.count).toHaveBeenCalledTimes(1);
  });

  it('WITH query: the exact COUNT is dropped — dbRead.user.count is NEVER called', async () => {
    // The username-search count is pathological + uncacheable, so the query path
    // drops it entirely and derives pagination from a take+1 over-fetch. No count
    // runs, and the cache machinery is never consulted.
    mockDb.user.findMany.mockResolvedValueOnce([{ username: 'a' }, { username: 'b' }]);

    const result = await getCreators({ select, count: true, excludeIds: [-1], query: 'foo', take: 20 });

    expect(mockDb.user.count).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
    // Returns a hasMore boolean instead of a count.
    expect(result).not.toHaveProperty('count');
    expect(result).toHaveProperty('hasMore');
  });

  it('WITH query, take+1 boundary: fewer than take+1 rows ⇒ hasMore=false, items untrimmed', async () => {
    // take=3 and exactly 3 rows returned (no +1 sentinel) → this is the last page.
    mockDb.user.findMany.mockResolvedValueOnce([
      { username: 'a' },
      { username: 'b' },
      { username: 'c' },
    ]);

    const result = await getCreators({ select, count: true, excludeIds: [-1], query: 'foo', take: 3 });

    // over-fetched take+1 = 4 rows
    expect(mockDb.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 4 }));
    expect((result as { hasMore: boolean }).hasMore).toBe(false);
    expect(result.items).toHaveLength(3);
  });

  it('WITH query, take+1 boundary: take+1 rows ⇒ hasMore=true, items trimmed back to take', async () => {
    // take=3 and 4 rows returned (the +1 sentinel) → there IS another page; the
    // sentinel row is trimmed off the returned items.
    mockDb.user.findMany.mockResolvedValueOnce([
      { username: 'a' },
      { username: 'b' },
      { username: 'c' },
      { username: 'd' },
    ]);

    const result = await getCreators({ select, count: true, excludeIds: [-1], query: 'foo', take: 3 });

    expect(mockDb.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 4 }));
    expect((result as { hasMore: boolean }).hasMore).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.items).toEqual([{ username: 'a' }, { username: 'b' }, { username: 'c' }]);
  });

  it('cache key VARIES by excludeIds → separate counts', async () => {
    mockDb.user.count.mockResolvedValueOnce(7).mockResolvedValueOnce(8);

    const a = await getCreators({ select, count: true, excludeIds: [-1] });
    const b = await getCreators({ select, count: true, excludeIds: [-1, 42] });

    expect(a.count).toBe(7);
    expect(b.count).toBe(8);
    expect(mockDb.user.count).toHaveBeenCalledTimes(2);
    expect(cacheStore.size).toBe(2);
  });

  it('cache key is order-independent for excludeIds (sorted) → reuses the same entry', async () => {
    mockDb.user.count.mockResolvedValue(99);

    const a = await getCreators({ select, count: true, excludeIds: [1, 2, 3] });
    const b = await getCreators({ select, count: true, excludeIds: [3, 1, 2] });

    expect(a.count).toBe(99);
    expect(b.count).toBe(99);
    // Same sorted key → one stored entry, one DB count.
    expect(mockDb.user.count).toHaveBeenCalledTimes(1);
    expect(cacheStore.size).toBe(1);
  });

  it('count:false → never touches the count cache or dbRead.user.count', async () => {
    const result = await getCreators({ select, count: false, excludeIds: [-1] });

    expect(result).not.toHaveProperty('count');
    expect(mockDb.user.count).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });

  it('count unset (default false) → never touches the count cache or dbRead.user.count', async () => {
    const result = await getCreators({ select, excludeIds: [-1] });

    expect(result).not.toHaveProperty('count');
    expect(mockDb.user.count).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });

  it('count cache stores the count, not the items array (cache value is the scalar)', async () => {
    mockDb.user.count.mockResolvedValueOnce(321);
    mockDb.user.findMany.mockResolvedValueOnce([{ username: 'x' }]);

    await getCreators({ select, count: true, excludeIds: [-1] });

    expect([...cacheStore.values()]).toEqual([321]);
  });

  it('fail-open: a cache/redis error degrades to running the count (no throw, correct value)', async () => {
    // Reproduce fetchThroughCache's fail-open contract: a Redis error means the
    // helper falls back to running fetchFn() directly rather than throwing.
    fetchThroughCacheImpl.fn = async (_key: string, fetchFn: () => Promise<unknown>) => {
      // simulate the internal redis read throwing → fail open to the origin fetch
      return fetchFn();
    };
    mockDb.user.count.mockResolvedValueOnce(456);

    const result = await getCreators({ select, count: true, excludeIds: [-1] });

    expect(result.count).toBe(456);
    expect(mockDb.user.count).toHaveBeenCalledTimes(1);
  });

  it('cache-throws fallback: fetchThroughCache rejecting still returns the count inline (no 500)', async () => {
    // FIX 🟡-2: on lock-retry exhaustion fetchThroughCache THROWS
    // ('Failed to fetch data through cache'). The caller wraps it in
    // `.catch(() => dbRead.user.count(...))` so the endpoint never 500s — it falls
    // back to running the count inline once.
    fetchThroughCacheImpl.fn = async () => {
      throw new Error('Failed to fetch data through cache');
    };
    mockDb.user.count.mockResolvedValueOnce(789);

    // Must NOT throw — resolves to the inline count.
    const result = await getCreators({ select, count: true, excludeIds: [-1] });

    expect(result.count).toBe(789);
    // The inline fallback ran the count exactly once (the throwing cache attempt
    // never reached fetchFn in this mock).
    expect(mockDb.user.count).toHaveBeenCalledTimes(1);
  });
});
