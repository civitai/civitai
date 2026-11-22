import { describe, expect, it, vi } from 'vitest';
import { checkFixedWindowWith, type FixedWindowCounter } from '../fixed-window';

/** A counter whose INCR returns `count` and whose TTL reads `ttl`. */
const counter = ({ count, ttl }: { count: number; ttl: number }) => {
  const redis = {
    incrBy: vi.fn(async () => count),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => ttl),
  };
  return redis as typeof redis & FixedWindowCounter;
};

describe('checkFixedWindowWith', () => {
  it('admits within the limit and starts the window on the first hit', async () => {
    const redis = counter({ count: 1, ttl: -1 });
    expect(await checkFixedWindowWith(redis, 'k', 5, 60)).toEqual({ allowed: true });
    expect(redis.incrBy).toHaveBeenCalledWith('k', 1);
    expect(redis.expire).toHaveBeenCalledWith('k', 60);
  });

  it('re-asserts a lost TTL, so the key cannot lock for good', async () => {
    const redis = counter({ count: 3, ttl: -1 });
    await checkFixedWindowWith(redis, 'k', 5, 60);
    expect(redis.expire).toHaveBeenCalledWith('k', 60);
  });

  it('refuses over the limit with the time left, or the whole window when the TTL is lost', async () => {
    expect(await checkFixedWindowWith(counter({ count: 6, ttl: 17 }), 'k', 5, 60)).toEqual({
      allowed: false,
      retryAfterSeconds: 17,
    });
    for (const ttl of [-1, -2, 0])
      expect(await checkFixedWindowWith(counter({ count: 6, ttl }), 'k', 5, 60)).toEqual({
        allowed: false,
        retryAfterSeconds: 60,
      });
  });

  it('admits on a Redis error by default, and refuses when asked to fail closed', async () => {
    const broken = {
      ...counter({ count: 1, ttl: 1 }),
      incrBy: vi.fn(async () => Promise.reject(new Error('down'))),
    };
    expect(await checkFixedWindowWith(broken, 'k', 5, 60)).toEqual({ allowed: true });
    expect(await checkFixedWindowWith(broken, 'k', 5, 60, { failOpen: false })).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });
});
