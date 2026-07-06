import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the redis client so cache ops run against a fake we can make throw. We assert the best-effort
// counter (notifications_redis_errors_total) increments on a redis op error AND that the error still
// propagates unchanged (behavior is non-behavioral except the counter).
const { fakeRedis } = vi.hoisted(() => {
  const fakeRedis = {
    hGetAll: vi.fn(),
    expire: vi.fn(),
    exists: vi.fn(),
    hSet: vi.fn(),
    hIncrBy: vi.fn(),
    hGet: vi.fn(),
    hDel: vi.fn(),
    del: vi.fn(),
  };
  return { fakeRedis };
});

vi.mock('./clients/redis', () => ({ getRedis: () => fakeRedis }));

import { notificationCache } from './cache';
import { redisErrorsTotal } from './metrics';

async function opValue(operation: string): Promise<number> {
  const metric = await redisErrorsTotal.get();
  return metric.values.find((v) => v.labels.operation === operation)?.value ?? 0;
}

describe('notification cache redis-error counting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments redis_errors_total{operation="get"} and rethrows when a get op errors', async () => {
    const before = await opValue('get');
    fakeRedis.hGetAll.mockRejectedValueOnce(new Error('READONLY'));

    await expect(notificationCache.getUser(42)).rejects.toThrow('READONLY');

    expect(await opValue('get')).toBe(before + 1);
  });

  it('does NOT increment the counter on a successful op', async () => {
    const before = await opValue('get');
    fakeRedis.hGetAll.mockResolvedValueOnce({});

    await expect(notificationCache.getUser(42)).resolves.toBeUndefined();

    expect(await opValue('get')).toBe(before);
  });

  it('counts the increment op under operation="increment"', async () => {
    const before = await opValue('increment');
    fakeRedis.hIncrBy.mockRejectedValueOnce(new Error('boom'));

    await expect(notificationCache.incrementUser(7, 'Comment')).rejects.toThrow('boom');

    expect(await opValue('increment')).toBe(before + 1);
  });
});
