import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for fetchThroughCache's malformed-entry guard.
 *
 * Background: `fetchThroughCache<T>` is declared to return `T`, but it returned
 * `cachedData.data` straight from Redis. An entry whose `data` was missing therefore
 * handed callers an `undefined` the type system had promised was impossible —
 * `model.getResourceSelect` crashed on exactly that (`Cannot read properties of
 * undefined (reading 'filter')`, ~120/day starting 2026-07-28, on the picker's
 * default-open path where the official-model pin is active).
 *
 * A missing `cachedAt` is the sibling trap: the staleness check compares
 * `Date.now() - ttl * 1000 > cachedData.cachedAt`, which is `NaN > n` → false, so a
 * malformed entry would be served indefinitely instead of expiring into a refresh.
 *
 * These pin that both shapes are treated as a MISS (origin fetch + rewrite, i.e. the
 * bad entry self-heals) while a healthy entry — including a legitimately-cached
 * `null` — is still served from cache.
 */

const getMock = vi.fn();
const setMock = vi.fn().mockResolvedValue(undefined);
const setNxMock = vi.fn().mockResolvedValue(true);
const delMock = vi.fn().mockResolvedValue(undefined);

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: {
      get: (...args: unknown[]) => getMock(...args),
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

vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));

import { fetchThroughCache } from '~/server/utils/cache-helpers';

const KEY = 'caches:official-models' as Parameters<typeof fetchThroughCache>[0];
const TTL = 300;
const ORIGIN = [{ id: 1, type: 'Checkpoint' }];

beforeEach(() => {
  getMock.mockReset();
  setMock.mockClear().mockResolvedValue(undefined);
  setNxMock.mockClear().mockResolvedValue(true);
  delMock.mockClear().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchThroughCache — malformed cache entry', () => {
  it('treats an entry with no `data` as a miss and refetches from origin', async () => {
    getMock.mockResolvedValue({ cachedAt: Date.now() });
    const fetchFn = vi.fn().mockResolvedValue(ORIGIN);

    const result = await fetchThroughCache(KEY, fetchFn, { ttl: TTL });

    expect(result).toEqual(ORIGIN);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rewrites the bad entry so it self-heals rather than staying poisoned', async () => {
    getMock.mockResolvedValue({ cachedAt: Date.now() });

    await fetchThroughCache(KEY, vi.fn().mockResolvedValue(ORIGIN), { ttl: TTL });

    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0][1]).toMatchObject({ data: ORIGIN });
  });

  it('treats a non-numeric `cachedAt` as a miss (NaN compare would never expire it)', async () => {
    getMock.mockResolvedValue({ data: ['stale'] });
    const fetchFn = vi.fn().mockResolvedValue(ORIGIN);

    const result = await fetchThroughCache(KEY, fetchFn, { ttl: TTL });

    expect(result).toEqual(ORIGIN);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('still serves a healthy fresh entry without hitting origin', async () => {
    getMock.mockResolvedValue({ data: ORIGIN, cachedAt: Date.now() });
    const fetchFn = vi.fn();

    const result = await fetchThroughCache(KEY, fetchFn, { ttl: TTL });

    expect(result).toEqual(ORIGIN);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('serves a legitimately-cached `null` — only `undefined` counts as missing', async () => {
    getMock.mockResolvedValue({ data: null, cachedAt: Date.now() });
    const fetchFn = vi.fn();

    const result = await fetchThroughCache(KEY, fetchFn, { ttl: TTL });

    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
