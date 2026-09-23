import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for `fetchThroughCache`'s `cacheName` option — the value that becomes the
 * `cache_name` label on the packed codec duration histogram.
 *
 * WHY THIS FILE EXISTS. `cacheName` is purely OBSERVATIONAL: no cached value, hit/miss decision
 * or return shape changes when it goes missing, so every behavioural test in this directory
 * stays green with the option silently dropped. The createCachedArray/createCachedObject half of
 * the same seam is guarded by driving the real builder (see
 * packages/civitai-redis/src/__tests__/packed-codec-metrics.test.ts); `fetchThroughCache` has no
 * builder to drive — each call site passes its own name — so the threading is pinned here
 * directly, against the real `fetchThroughCache` with redis mocked.
 *
 * Four things a mutant can break, one test each:
 *   1. the READ carries it,
 *   2. the WRITE carries it,
 *   3. the LOCK-LOSER'S RETRY carries it — the recursion re-spells the options object by hand, so
 *      it is the one path where the label can be dropped while the first attempt still looks
 *      correct, and the samples then land under the fallback label instead of the caller's cache,
 *   4. a caller that names no cache gets `undefined` here — the 'unknown' fallback belongs to the
 *      redis client (PACKED_CODEC_UNNAMED_CACHE); spelling it a second time in this module is how
 *      the two copies drift.
 */

const getMock = redisMock.redis.packed.get;
const setMock = redisMock.redis.packed.set;
const setNxMock = redisMock.redis.setNxKeepTtlWithEx;
const delMock = redisMock.redis.del;

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));

import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// CACHE_NAME is deliberately NOT a prefix of nothing and NOT equal to KEY: `key` is routinely
// `${prefix}:${id}`, and labelling with the key would make `cache_name` unbounded. A mutant that
// passes `key` where `cacheName` belongs is visible because the two literals differ.
const CACHE_NAME = 'packed:caches:cache-name-probe';
const KEY = `${CACHE_NAME}:4242` as Parameters<typeof fetchThroughCache>[0];
const TTL = 300;
const ORIGIN = { id: 4242, value: 'origin' };

type PackedOpts = { compress?: boolean; cacheName?: string } | undefined;
const readOpts = (call: number) => getMock.mock.calls[call]?.[1] as PackedOpts;
const writeOpts = (call: number) => setMock.mock.calls[call]?.[3] as PackedOpts;

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(null);
  setMock.mockReset().mockResolvedValue(undefined);
  setNxMock.mockReset().mockResolvedValue(true);
  delMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('fetchThroughCache — cacheName threading', () => {
  it('threads cacheName to the packed READ', async () => {
    await fetchThroughCache(KEY, async () => ORIGIN, {
      ttl: TTL,
      compress: true,
      cacheName: CACHE_NAME,
    });

    expect(readOpts(0)?.cacheName, 'the packed READ carries the caller cacheName').toBe(CACHE_NAME);
    expect(readOpts(0)?.compress).toBe(true);
  });

  it('threads cacheName to the packed WRITE', async () => {
    await fetchThroughCache(KEY, async () => ORIGIN, {
      ttl: TTL,
      compress: true,
      cacheName: CACHE_NAME,
    });

    expect(writeOpts(0)?.cacheName, 'the packed WRITE carries the caller cacheName').toBe(
      CACHE_NAME
    );
    expect(writeOpts(0)?.compress).toBe(true);
  });

  it('never substitutes the per-id key for the cache name', async () => {
    await fetchThroughCache(KEY, async () => ORIGIN, {
      ttl: TTL,
      compress: true,
      cacheName: CACHE_NAME,
    });

    expect(readOpts(0)?.cacheName, 'cache_name must be the PREFIX, not the per-id key').not.toBe(
      KEY
    );
    expect(writeOpts(0)?.cacheName, 'cache_name must be the PREFIX, not the per-id key').not.toBe(
      KEY
    );
  });

  it('passes cacheName undefined when the caller names no cache (no second fallback literal)', async () => {
    await fetchThroughCache(KEY, async () => ORIGIN, { ttl: TTL, compress: true });

    expect(
      readOpts(0)?.cacheName,
      'an unnamed caller reaches the client as undefined; the client owns the fallback label'
    ).toBeUndefined();
    expect(writeOpts(0)?.cacheName).toBeUndefined();
  });

  // 🔴 THE RETRY. A lock loser with no stale value to serve sleeps and RE-ENTERS
  // fetchThroughCache with a hand-respelled options object. Every other path reads
  // `options.cacheName` once; this one rebuilds the object from locals, so it is the only place
  // the label can go missing while the first attempt still looks perfectly correct.
  it('preserves cacheName across the lock-loser retry', async () => {
    // First attempt: cache empty AND lock lost → sleep → recurse. Second attempt wins the lock,
    // runs the origin fetch, and writes.
    setNxMock.mockResolvedValueOnce(false).mockResolvedValue(true);

    await fetchThroughCache(KEY, async () => ORIGIN, {
      ttl: TTL,
      lockTTL: 0.01, // keeps the retry's sleep((lockTTL*1000)/2) at ~5ms
      compress: true,
      cacheName: CACHE_NAME,
    });

    // Positive control: the retry really happened, so the assertion below is reachable.
    expect(
      getMock.mock.calls.length,
      'the lock-loser actually retried (a second packed read happened)'
    ).toBeGreaterThanOrEqual(2);

    expect(readOpts(1)?.cacheName, 'the RETRY read still carries cacheName').toBe(CACHE_NAME);
    expect(readOpts(1)?.compress, 'the RETRY read still carries compress').toBe(true);
    expect(writeOpts(0)?.cacheName, 'the write after the retry still carries cacheName').toBe(
      CACHE_NAME
    );
  });
});
