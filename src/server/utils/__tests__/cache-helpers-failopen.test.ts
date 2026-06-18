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
// clearCacheByPattern drives SCAN via scanNodes()/scanNodeStep(); mocks let us
// simulate a clipped (deadline-rejected) SCAN/del step deterministically.
const scanNodesMock = vi.fn();
const scanNodeStepMock = vi.fn();

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: {
      mGet: (...args: unknown[]) => mGetMock(...args),
      set: (...args: unknown[]) => setMock(...args),
    },
    setNxKeepTtlWithEx: (...args: unknown[]) => setNxMock(...args),
    del: (...args: unknown[]) => delMock(...args),
    scanNodes: (...args: unknown[]) => scanNodesMock(...args),
    scanNodeStep: (...args: unknown[]) => scanNodeStepMock(...args),
  },
  sysRedis: {},
  REDIS_KEYS: { CACHE_LOCKS: 'caches:lock' },
}));

// Keep the fail-open logger inert (it's fire-and-forget Axiom/Loki, not under test).
vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));

import {
  clearCacheByPattern,
  createCachedArray,
  createCachedObject,
} from '~/server/utils/cache-helpers';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

type Row = { id: number; name: string };

beforeEach(() => {
  mGetMock.mockReset();
  setMock.mockClear();
  setNxMock.mockClear();
  delMock.mockClear().mockResolvedValue(undefined);
  scanNodesMock.mockReset();
  scanNodeStepMock.mockReset();
  vi.mocked(logSysRedisFailOpen).mockClear();
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

  it('propagates a lookupFn error to a JOINER too — the overlapping joiner does not hang or get a partial result', async () => {
    // Owner [1,2,3] originates its per-id promises then its DB call rejects. A concurrent
    // joiner [2,3,4] reuses the owner's in-flight 2,3 (which will reject) and originates 4.
    // The joiner MUST reject (inherit the shared-id failure) — not hang, not return [4].
    mGetMock.mockRejectedValue(new Error('redis cluster command timed out after 3000ms'));

    let releaseOwner: () => void;
    const ownerGate = new Promise<void>((r) => (releaseOwner = r));
    let call = 0;
    const lookupFn = vi.fn(async (ids: number[]) => {
      call++;
      if (call === 1) {
        // The owner's batched DB call — hold it open, then fail it.
        await ownerGate;
        throw new Error('owner DB failure');
      }
      // The joiner's own DB call for its non-shared id (4) succeeds.
      return Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<
        string,
        Row
      >;
    });

    const cache = createCachedArray<Row>({ key: 'test:joinerr' as never, idKey: 'id', lookupFn });

    const owner = cache.fetch([1, 2, 3]); // registers per-id in-flight for 1,2,3, awaits ownerGate
    await Promise.resolve();
    await Promise.resolve();
    const joiner = cache.fetch([2, 3, 4]); // reuses 2,3 in-flight; originates 4
    await Promise.resolve();
    await Promise.resolve();

    releaseOwner!(); // owner's DB call now throws → rejects 1,2,3 (incl. the joiner's reused 2,3)

    await expect(owner).rejects.toThrow(/owner DB failure/);
    await expect(joiner).rejects.toThrow(/owner DB failure/);
  });

  it('does NOT leak settled per-id promises — a later degraded fetch RE-originates (after resolve AND after reject)', async () => {
    mGetMock.mockRejectedValue(new Error('redis cluster command timed out after 3000ms'));

    // Round 1: resolves. The per-id in-flight entries for 1,2,3 must be cleaned up on settle.
    const lookupOk = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );
    const cacheOk = createCachedArray<Row>({ key: 'test:noleak-ok' as never, idKey: 'id', lookupFn: lookupOk });
    await cacheOk.fetch([1, 2, 3]);
    expect(lookupOk).toHaveBeenCalledTimes(1);
    // A subsequent degraded fetch of the SAME ids must call the origin AGAIN (not be served
    // from a stale settled promise) — proving the in-flight entry was deleted on resolve.
    await cacheOk.fetch([1, 2, 3]);
    expect(lookupOk).toHaveBeenCalledTimes(2);

    // Round 2: a fetch that REJECTS must also clean up, so the next fetch re-originates.
    let shouldThrow = true;
    const lookupErr = vi.fn(async (ids: number[]) => {
      if (shouldThrow) throw new Error('transient DB failure');
      return Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<
        string,
        Row
      >;
    });
    const cacheErr = createCachedArray<Row>({ key: 'test:noleak-err' as never, idKey: 'id', lookupFn: lookupErr });
    await expect(cacheErr.fetch([1, 2, 3])).rejects.toThrow(/transient DB failure/);
    expect(lookupErr).toHaveBeenCalledTimes(1);
    // The rejected in-flight entries must be gone — the retry re-originates and now succeeds.
    shouldThrow = false;
    const recovered = await cacheErr.fetch([1, 2, 3]);
    expect(lookupErr).toHaveBeenCalledTimes(2);
    expect(recovered.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('filters an ABSENT id from the degraded result — no null/undefined, shape matches the normal path', async () => {
    mGetMock.mockRejectedValue(new Error('redis cluster command timed out after 3000ms'));
    // DB has no row for id 2 (returns only 1 and 3).
    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(
        ids.filter((id) => id !== 2).map((id) => [id, { id, name: `db-${id}` }])
      ) as Record<string, Row>
    );

    const cache = createCachedArray<Row>({ key: 'test:absent' as never, idKey: 'id', lookupFn });
    const result = await cache.fetch([1, 2, 3]);

    // The absent id is filtered out — exactly [1,3], with no null/undefined entries.
    expect(result.every((r) => r != null)).toBe(true);
    expect(result.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 3]);
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

describe('clearCacheByPattern — clipped SCAN/del resilience', () => {
  // Build a single-node scan that yields keys across cursor steps. `failures` maps a
  // cursor value to the number of times its SCAN should reject before succeeding (to
  // simulate a deadline-clipped step that recovers on retry).
  function setupNode(
    steps: { cursor: string; keys: string[]; nextCursor: string }[],
    failures: Record<string, number> = {}
  ) {
    const node = { id: 'single', scan: vi.fn() };
    scanNodesMock.mockResolvedValue([node]);
    const remaining = { ...failures };
    scanNodeStepMock.mockImplementation(async (_node: unknown, cursor: string) => {
      if (remaining[cursor] && remaining[cursor] > 0) {
        remaining[cursor]--;
        throw new Error(`SCAN clipped at cursor ${cursor} (deadline 3000ms)`);
      }
      const step = steps.find((s) => s.cursor === cursor);
      if (!step) throw new Error(`unexpected cursor ${cursor}`);
      return { keys: step.keys, cursor: step.nextCursor };
    });
    return node;
  }

  it('retries a clipped SCAN step from the SAME cursor and completes the full drain', async () => {
    // Two cursor steps; the first SCAN is clipped twice then succeeds (bounded retry).
    setupNode(
      [
        { cursor: '0', keys: ['k:1', 'k:2'], nextCursor: '12' },
        { cursor: '12', keys: ['k:3'], nextCursor: '0' },
      ],
      { '0': 2 } // clip cursor '0' twice, then it succeeds
    );

    const cleared = await clearCacheByPattern('k:*' as never);

    // All keys across both steps deleted despite the transient clips.
    expect(cleared.sort()).toEqual(['k:1', 'k:2', 'k:3']);
    expect(delMock).toHaveBeenCalledTimes(3);
    // The clip recovered on retry — no fail-open log fired.
    expect(logSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('does NOT silently abort when a SCAN step exhausts retries — logs loudly and continues best-effort', async () => {
    // First step yields keys and advances; the SECOND step's cursor is clipped forever.
    setupNode(
      [
        { cursor: '0', keys: ['k:1'], nextCursor: '99' },
        { cursor: '99', keys: ['k:2'], nextCursor: '0' },
      ],
      { '99': 99 } // never recovers
    );

    const cleared = await clearCacheByPattern('k:*' as never);

    // Best-effort: the first step's key was cleared; the unscanned tail surfaced as a log.
    expect(cleared).toEqual(['k:1']);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      expect.stringContaining('SCAN'),
      expect.any(Error),
      expect.objectContaining({ partial: true, cursor: '99' })
    );
  });

  it('retries a clipped del and surfaces a del that exhausts retries (does not drop it silently)', async () => {
    setupNode([{ cursor: '0', keys: ['k:1', 'k:2'], nextCursor: '0' }]);
    // k:1 del clipped once then succeeds; k:2 del always fails.
    let k1Fails = 1;
    delMock.mockImplementation(async (key: string) => {
      if (key === 'k:1' && k1Fails > 0) {
        k1Fails--;
        throw new Error('del clipped (deadline 3000ms)');
      }
      if (key === 'k:2') throw new Error('del clipped forever');
      return undefined;
    });

    const cleared = await clearCacheByPattern('k:*' as never);

    // k:1 recovered on retry → cleared; k:2 exhausted → logged, not in cleared.
    expect(cleared).toEqual(['k:1']);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      expect.stringContaining('del'),
      expect.any(Error),
      expect.objectContaining({ key: 'k:2', partial: true })
    );
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
