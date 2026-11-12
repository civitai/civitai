import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * fetchThroughCache serve-stale-on-origin-error (FETCH_THROUGH_CACHE_SERVE_STALE, dark).
 *
 * Entries live for ttl*2 but are refreshed after ttl, so between the two an expired copy is still
 * readable. With the switch on, an origin fetch that throws during that refresh answers with the
 * expired copy instead of the error. A caller that must never see an expired value opts out with
 * `serveStaleOnError: false`, and nothing is served when there is no copy at all.
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

const KEY = 'packed:caches:serve-stale-test' as RedisKeyTemplateCache;
const STALE = { label: 'from an hour ago' };
const originDown = () => Promise.reject(new Error('origin down'));

beforeEach(() => {
  vi.clearAllMocks();
  // An entry written an hour ago against a 60s ttl: expired, still readable.
  redisMock.redis.packed.get.mockResolvedValue({ data: STALE, cachedAt: Date.now() - 3_600_000 });
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
  redisMock.redis.del.mockResolvedValue(1);
});

describe('fetchThroughCache serve-stale on origin error', () => {
  it('switch on: an origin error during refresh answers with the expired entry', async () => {
    setEnv({ FETCH_THROUGH_CACHE_SERVE_STALE: true });

    await expect(fetchThroughCache(KEY, originDown, { ttl: 60 })).resolves.toEqual(STALE);
  });

  it('switch on, caller opted out: the origin error propagates', async () => {
    setEnv({ FETCH_THROUGH_CACHE_SERVE_STALE: true });

    await expect(
      fetchThroughCache(KEY, originDown, { ttl: 60, serveStaleOnError: false })
    ).rejects.toThrow('origin down');
  });

  it('switch off: the origin error propagates', async () => {
    setEnv({ FETCH_THROUGH_CACHE_SERVE_STALE: false });

    await expect(fetchThroughCache(KEY, originDown, { ttl: 60 })).rejects.toThrow('origin down');
  });

  it('switch on, nothing cached: the origin error propagates', async () => {
    setEnv({ FETCH_THROUGH_CACHE_SERVE_STALE: true });
    redisMock.redis.packed.get.mockResolvedValue(null);

    await expect(fetchThroughCache(KEY, originDown, { ttl: 60 })).rejects.toThrow('origin down');
  });
});
