import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fail-open coverage for createCachedArray / createCachedObject `.fetch`.
 *
 * Background (PR #2611 + this PR): a node-redis CLUSTER (cache) command can wedge — the
 * #2556 socketTimeout / #2611 command-deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS, lowered to
 * 3s here) now make a stuck read REJECT instead of hanging ~125s. But the cachedArray read
 * path had NO try/catch around its `redis.packed.mGet`, so that reject propagated → TRPCError
 * → 500 (a 68-min 500 spike on two wedged API pods on 2026-06-17, concentrated on the
 * createCachedObject routes tag.getAll / user.getCreator / image.getGenerationData). These
 * tests pin the contract that the read now fails OPEN to a per-id single-flighted origin
 * (lookupFn) fetch — mirroring fetchThroughCache — and that the best-effort writes/locks never
 * turn a successful origin fetch into a 500.
 *
 * The redis client is mocked so we can force a read/write rejection deterministically. The
 * fail-open logger is stubbed to a no-op (fire-and-forget Axiom/Loki I/O, not under test).
 */

// Controllable fake CLUSTER redis client. Each method can be flipped to reject to simulate a
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
  REDIS_KEYS: { CACHE_LOCKS: 'caches:lock', TAG: 'caches:tag' },
}));

// Keep the fail-open logger inert (fire-and-forget Axiom/Loki, not under test).
vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));

import { createCachedArray, createCachedObject } from '~/server/utils/cache-helpers';

type Row = { id: number; name: string };

const REDIS_TIMEOUT = () => new Error('redis cluster command timed out after 3000ms');

// Flush queued microtasks so all concurrent fetches reach the fail-open path before a gated
// lookupFn resolves.
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  mGetMock.mockReset();
  setMock.mockClear().mockResolvedValue(undefined);
  setNxMock.mockClear().mockResolvedValue(true);
  delMock.mockClear().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCachedArray.fetch — CLUSTER read fail-open', () => {
  it('returns the ORIGIN (lookupFn) result instead of throwing when the redis read rejects', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );

    const cache = createCachedArray<Row>({ key: 'test:read' as never, idKey: 'id', lookupFn });

    // BEFORE this fix this rejected (→ TRPCError → 500). It must now resolve to the origin
    // result (degraded slow-200).
    const result = await cache.fetch([1, 2, 3]);

    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(result.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(result.find((r) => r.id === 2)?.name).toBe('db-2');
    // Degraded path must not attempt cache writes (redis is down).
    expect(setMock).not.toHaveBeenCalled();
  });

  it('omits ids the origin has no row for (notFound semantics preserved, no throw)', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    // id 2 missing from the DB result.
    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.filter((id) => id !== 2).map((id) => [id, { id, name: `db-${id}` }]))
    );
    const cache = createCachedArray<Row>({ key: 'test:nf' as never, idKey: 'id', lookupFn });

    const result = await cache.fetch([1, 2, 3]);
    expect(result.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('runs appendFn on the degraded results (decorator contract preserved)', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>;
    const appendFn = vi.fn(async (rows: Set<Row>) => {
      for (const r of rows) r.name = `decorated-${r.id}`;
    });
    const cache = createCachedArray<Row>({ key: 'test:append' as never, idKey: 'id', lookupFn, appendFn });

    const result = await cache.fetch([7, 8]);
    expect(appendFn).toHaveBeenCalledTimes(1);
    expect(result.find((r) => r.id === 7)?.name).toBe('decorated-7');
  });

  it('PROPAGATES a genuine lookupFn (origin/DB) error — fail-open does NOT swallow it', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = vi.fn(async () => {
      throw new Error('db exploded');
    });
    const cache = createCachedArray<Row>({ key: 'test:dberr' as never, idKey: 'id', lookupFn });

    await expect(cache.fetch([1, 2])).rejects.toThrow('db exploded');
  });
});

describe('createCachedArray.fetch — per-id single-flight (DB stampede bound)', () => {
  it('coalesces OVERLAPPING id-sets so each id is looked up at most once concurrently', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());

    // Gated lookupFn: stays pending until released, forcing the two fetches to overlap.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lookupCalls: number[][] = [];
    const lookupFn = vi.fn(async (ids: number[]) => {
      lookupCalls.push([...ids]);
      await gate;
      return Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>;
    });

    const cache = createCachedArray<Row>({ key: 'test:sf' as never, idKey: 'id', lookupFn });

    const p1 = cache.fetch([1, 2]);
    await flush(); // let fetch#1 register ids 1,2 in the in-flight map
    const p2 = cache.fetch([2, 3]); // id 2 overlaps → must reuse, only 3 is newly fetched
    await flush();

    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    // id 2 must appear in EXACTLY one lookupFn call (coalesced), never duplicated.
    const allLookedUp = lookupCalls.flat();
    expect(allLookedUp.filter((id) => id === 2)).toHaveLength(1);
    expect([...new Set(allLookedUp)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // Both callers still get their full, correct id-set back.
    expect(r1.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(r2.map((r) => r.id).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('does NOT leak in-flight entries: a fetch after settle re-issues the origin lookup', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );
    const cache = createCachedArray<Row>({ key: 'test:leak' as never, idKey: 'id', lookupFn });

    await cache.fetch([5]); // settles → entry for id 5 must be deleted
    await cache.fetch([5]); // would reuse a stale promise if the map leaked
    expect(lookupFn).toHaveBeenCalledTimes(2);
  });

  it('rejects every joined caller when the shared origin fetch fails, then clears the entry', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    let calls = 0;
    const lookupFn = vi.fn(async () => {
      calls++;
      throw new Error(`db fail #${calls}`);
    });
    const cache = createCachedArray<Row>({ key: 'test:joinerr' as never, idKey: 'id', lookupFn });

    await expect(cache.fetch([9])).rejects.toThrow('db fail #1');
    // Entry cleared on rejection → next fetch issues a NEW lookup (not a stuck rejected promise).
    await expect(cache.fetch([9])).rejects.toThrow('db fail #2');
  });
});

describe('createCachedObject.fetch — fail-open + best-effort writes', () => {
  it('fails open to a keyed Record from the origin when the read rejects', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>;
    const cache = createCachedObject<Row>({ key: 'test:obj' as never, idKey: 'id', lookupFn });

    const result = await cache.fetch([1, 2]);
    expect(Object.keys(result).sort()).toEqual(['1', '2']);
    expect(result['2'].name).toBe('db-2');
  });

  it('does NOT 500 when the cache WRITE-back rejects after a successful origin miss-fetch', async () => {
    // Healthy read (empty → all misses), but the write-back to redis rejects (partial wedge).
    mGetMock.mockResolvedValue([]); // no cached entries → every id is a miss
    setMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>;
    // cacheNotFound default true → notFound writes also attempted; both must be swallowed.
    const cache = createCachedObject<Row>({ key: 'test:wb' as never, idKey: 'id', lookupFn });

    const result = await cache.fetch([1, 2]);
    expect(setMock).toHaveBeenCalled(); // it tried to write
    expect(Object.keys(result).sort()).toEqual(['1', '2']); // and still returned the data
  });
});
