import { describe, expect, it, vi } from 'vitest';
import { prefixCacheKey } from '@civitai/redis';
import { RETRACTED_MEDIA_RATE_LIMIT, retractedMediaRateKey } from '@civitai/shared/retracted-media';

vi.mock('../redis', () => ({
  getRedis: () => {
    throw new Error('the test passes its own counter');
  },
}));

const { retractedMediaRetryAfter } = await import('../retracted-media-rate');

function counter() {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    incrBy: vi.fn(async (key: string, by: number) => {
      const next = (counts.get(key) ?? 0) + by;
      counts.set(key, next);
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => void ttls.set(key, seconds)),
    ttl: vi.fn(async (key: string) => ttls.get(key) ?? -1),
  };
}

describe('retractedMediaRetryAfter', () => {
  it('lets a moderator through up to the limit a minute, then says how long to wait', async () => {
    const redis = counter();
    for (let i = 0; i < RETRACTED_MEDIA_RATE_LIMIT; i++)
      expect(await retractedMediaRetryAfter(7, redis as never)).toBeNull();
    expect(await retractedMediaRetryAfter(7, redis as never)).toBe(60);
    expect(await retractedMediaRetryAfter(8, redis as never)).toBeNull();
  });

  it("counts under the main app's key for the moderator", async () => {
    const redis = counter();
    await retractedMediaRetryAfter(7, redis as never);
    expect(redis.incrBy).toHaveBeenCalledWith(prefixCacheKey(retractedMediaRateKey(7)), 1);
    expect(retractedMediaRateKey(7)).toBe('retracted-media:rate-limit:7');
  });

  it("answers with the window's remaining seconds, and restores a lost expiry", async () => {
    const redis = counter();
    const key = prefixCacheKey(retractedMediaRateKey(7));
    for (let i = 0; i < RETRACTED_MEDIA_RATE_LIMIT; i++)
      await retractedMediaRetryAfter(7, redis as never);
    redis.ttl.mockResolvedValueOnce(17).mockResolvedValueOnce(17);
    expect(await retractedMediaRetryAfter(7, redis as never)).toBe(17);
    redis.expire.mockClear();
    redis.ttl.mockResolvedValueOnce(-1);
    await retractedMediaRetryAfter(7, redis as never);
    expect(redis.expire).toHaveBeenCalledWith(key, 60);
  });

  it('refuses when the counter cannot be read', async () => {
    const redis = counter();
    redis.incrBy.mockRejectedValue(new Error('redis down'));
    expect(await retractedMediaRetryAfter(7, redis as never)).toBe(60);
  });
});
