import { beforeEach, describe, expect, it } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  checkSubListingSyncRateLimit,
  SUB_LISTING_SYNC_DAILY_MAX,
  SUB_LISTING_SYNC_HOURLY_MAX,
} from '~/server/utils/shared-storage-rate-limit';

/** The per-parent catalog-sync budget: an hourly and a daily fixed window, keyed by parent. */

const counts = new Map<string, number>();

beforeEach(() => {
  resetSharedMocks();
  counts.clear();
  redisMock.redis.incrBy.mockImplementation(async (key: string, by: number) => {
    const next = (counts.get(key) ?? 0) + by;
    counts.set(key, next);
    return next;
  });
  redisMock.redis.ttl.mockResolvedValue(42);
});

const keys = () => [...counts.keys()];

describe('checkSubListingSyncRateLimit', () => {
  it('pins the windows at 600/hour and 3000/day', () => {
    expect(SUB_LISTING_SYNC_HOURLY_MAX).toBe(600);
    expect(SUB_LISTING_SYNC_DAILY_MAX).toBe(3000);
  });

  it('counts per parent, in an hourly and a daily bucket', async () => {
    await checkSubListingSyncRateLimit('apl_A');
    await checkSubListingSyncRateLimit('apl_B');
    expect(keys()).toHaveLength(4);
    expect(keys().filter((k) => k.includes(':sub-listing-sync:apl_A:'))).toHaveLength(2);
    expect(redisMock.redis.expire).toHaveBeenCalledWith(expect.stringMatching(/:h$/), 3600);
    expect(redisMock.redis.expire).toHaveBeenCalledWith(expect.stringMatching(/:d$/), 86400);
  });

  it('allows the 600th write in an hour and refuses the 601st', async () => {
    const hourly = (await checkSubListingSyncRateLimit('apl_A'), keys()[0]);
    counts.set(hourly, 599);
    await expect(checkSubListingSyncRateLimit('apl_A')).resolves.toEqual({ allowed: true });
    await expect(checkSubListingSyncRateLimit('apl_A')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 42,
    });
    // Another parent keeps its own budget.
    await expect(checkSubListingSyncRateLimit('apl_B')).resolves.toEqual({ allowed: true });
  });

  it('allows the 3000th write in a day and refuses the 3001st, under the hourly cap', async () => {
    await checkSubListingSyncRateLimit('apl_A');
    const daily = keys().find((k) => k.endsWith(':d')) as string;
    counts.set(daily, 2999);
    await expect(checkSubListingSyncRateLimit('apl_A')).resolves.toEqual({ allowed: true });
    await expect(checkSubListingSyncRateLimit('apl_A')).resolves.toMatchObject({
      allowed: false,
    });
  });
});
