import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_RATE_LIMIT } from '~/shared/constants/feedback.constants';

const { incrByMock, expireMock, ttlMock, countMock, createMock } = vi.hoisted(() => ({
  incrByMock: vi.fn(),
  expireMock: vi.fn(),
  ttlMock: vi.fn(),
  countMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    feedback: { count: vi.fn(() => Promise.reject(new Error('must not read the replica'))) },
  },
  dbWrite: { feedback: { count: countMock, create: createMock } },
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { incrBy: incrByMock, expire: expireMock, ttl: ttlMock },
  REDIS_SYS_KEYS: { FEEDBACK: { RATE_LIMIT: 'system:feedback:rate-limit' } },
}));

vi.mock('~/server/flipt/client', () => ({
  getFliptBoolean: vi.fn().mockResolvedValue(false),
  FLIPT_FEATURE_FLAGS: {},
}));

import { createFeedback } from '../feedback.service';

const input = { userId: 1, area: 'bitdex-image-feed' as const, message: 'feed looks wrong' };

describe('createFeedback rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({ id: 1 });
    ttlMock.mockResolvedValue(3600);
  });

  it('writes the row when the counter is under the hourly cap', async () => {
    incrByMock.mockResolvedValue(FEEDBACK_RATE_LIMIT.max - 1);

    await expect(createFeedback(input)).resolves.toEqual({ id: 1 });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with TOO_MANY_REQUESTS past the cap, without writing', async () => {
    incrByMock.mockResolvedValue(FEEDBACK_RATE_LIMIT.max + 1);

    await expect(createFeedback(input)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(createMock).not.toHaveBeenCalled();
  });

  // The bypass this exists for: a check-then-act limit lets N concurrent submits
  // each read the same pre-write count and all pass. A real INCR cannot.
  it('admits exactly the cap when submissions arrive concurrently', async () => {
    let counter = 0;
    incrByMock.mockImplementation(async () => ++counter);

    const attempts = await Promise.allSettled(
      Array.from({ length: FEEDBACK_RATE_LIMIT.max + 5 }, () => createFeedback(input))
    );

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(FEEDBACK_RATE_LIMIT.max);
    expect(createMock).toHaveBeenCalledTimes(FEEDBACK_RATE_LIMIT.max);
  });

  describe('when redis is unavailable', () => {
    beforeEach(() => {
      incrByMock.mockRejectedValue(new Error('redis down'));
    });

    it('counts a window that ends one hour BEFORE now, on the writer', async () => {
      countMock.mockResolvedValue(0);

      await createFeedback(input);

      const where = countMock.mock.calls[0][0].where;
      expect(where.userId).toBe(1);
      // A sign flip or a zero window would leave this off by an hour or more.
      const elapsedMs = Date.now() - (where.createdAt.gt as Date).getTime();
      expect(elapsedMs).toBeGreaterThan(FEEDBACK_RATE_LIMIT.windowMs - 10_000);
      expect(elapsedMs).toBeLessThan(FEEDBACK_RATE_LIMIT.windowMs + 10_000);
    });

    it('still rejects at the cap', async () => {
      countMock.mockResolvedValue(FEEDBACK_RATE_LIMIT.max);

      await expect(createFeedback(input)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(createMock).not.toHaveBeenCalled();
    });
  });
});
