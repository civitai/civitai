import { beforeEach, describe, expect, it } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { checkActivityRateLimit } from '~/server/utils/activity-rate-limit';

// The activity beacon's limiter must keep its state on the cache cluster (`redis`), never on
// sysRedis, which holds durable state. Driven through the real fixed-window primitive, so the
// assertion is on which client receives the INCR, not on a mocked wrapper.

describe('checkActivityRateLimit', () => {
  beforeEach(() => {
    redisMock.redis.incrBy.mockReset();
    redisMock.redis.ttl.mockReset();
    redisMock.redis.expire.mockReset();
    redisMock.sysRedis.incrBy.mockReset();
    redisMock.redis.ttl.mockResolvedValue(30);
    redisMock.redis.expire.mockResolvedValue(true);
  });

  it('counts on the cache cluster, keyed per IP, and never touches sysRedis', async () => {
    redisMock.redis.incrBy.mockResolvedValue(1);

    await expect(checkActivityRateLimit('198.51.100.9')).resolves.toEqual({ allowed: true });

    expect(redisMock.redis.incrBy).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.incrBy.mock.calls[0][0]).toContain(
      'activity:rate-limit:ip:198.51.100.9'
    );
    expect(redisMock.sysRedis.incrBy).not.toHaveBeenCalled();
  });

  it('allows the 120th request in a window and refuses the 121st', async () => {
    redisMock.redis.incrBy.mockResolvedValueOnce(120);
    await expect(checkActivityRateLimit('198.51.100.9')).resolves.toEqual({ allowed: true });

    redisMock.redis.incrBy.mockResolvedValueOnce(121);
    await expect(checkActivityRateLimit('198.51.100.9')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
  });

  it('fails open when the cache is unavailable', async () => {
    redisMock.redis.incrBy.mockRejectedValue(new Error('connection lost'));
    await expect(checkActivityRateLimit('198.51.100.9')).resolves.toEqual({ allowed: true });
  });
});
