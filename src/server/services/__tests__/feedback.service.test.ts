import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_RATE_LIMIT } from '~/shared/constants/feedback.constants';

const { incrByMock, decrByMock, expireMock, ttlMock, countMock, createMock, logToAxiomMock } =
  vi.hoisted(() => ({
    incrByMock: vi.fn(),
    decrByMock: vi.fn(),
    expireMock: vi.fn(),
    ttlMock: vi.fn(),
    countMock: vi.fn(),
    createMock: vi.fn(),
    logToAxiomMock: vi.fn(async () => undefined),
  }));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    feedback: { count: vi.fn(() => Promise.reject(new Error('must not read the replica'))) },
  },
  dbWrite: { feedback: { count: countMock, create: createMock } },
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { incrBy: incrByMock, decrBy: decrByMock, expire: expireMock, ttl: ttlMock },
  REDIS_SYS_KEYS: { FEEDBACK: { RATE_LIMIT: 'system:feedback:rate-limit' } },
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: logToAxiomMock }));

vi.mock('~/server/flipt/client', () => ({
  getFliptBoolean: vi.fn().mockResolvedValue(false),
  FLIPT_FEATURE_FLAGS: {},
}));

import { createFeedback } from '../feedback.service';

// The per-user key. Asserted literally: with expect.any(String) a key that
// dropped its userId segment — one global bucket for the whole site — passes.
const RATE_LIMIT_KEY = 'system:feedback:rate-limit:1';

const input = { userId: 1, area: 'bitdex-image-feed' as const, message: 'feed looks wrong' };

describe('createFeedback rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({ id: 1 });
    ttlMock.mockResolvedValue(3600);
    decrByMock.mockResolvedValue(0);
  });

  // Without an expiry the window never rolls: the fifth submission bars the user
  // for good. Deleting either expire call is invisible to every other assertion.
  it('arms the window expiry on the first submission of a window', async () => {
    incrByMock.mockResolvedValue(1);

    await createFeedback(input);

    expect(expireMock).toHaveBeenCalledWith(RATE_LIMIT_KEY, 3600);
  });

  it('re-arms an expiry that went missing on a later submission', async () => {
    incrByMock.mockResolvedValue(2);
    ttlMock.mockResolvedValue(-1);

    await createFeedback(input);

    expect(expireMock).toHaveBeenCalledWith(RATE_LIMIT_KEY, 3600);
  });

  it('leaves a healthy expiry alone', async () => {
    incrByMock.mockResolvedValue(2);
    ttlMock.mockResolvedValue(1800);

    await createFeedback(input);

    expect(expireMock).not.toHaveBeenCalled();
  });

  // A slot is spent on the write, not the attempt: five failed inserts must not
  // lock someone out for an hour with no row to show for it.
  it('refunds the reserved slot when the insert fails', async () => {
    incrByMock.mockResolvedValue(1);
    createMock.mockRejectedValue(new Error('relation "Feedback" does not exist'));

    await expect(createFeedback(input)).rejects.toThrow('relation "Feedback" does not exist');
    expect(decrByMock).toHaveBeenCalledWith(RATE_LIMIT_KEY, 1);
  });

  it('does not refund a slot it never reserved (redis was down)', async () => {
    incrByMock.mockRejectedValue(new Error('redis down'));
    countMock.mockResolvedValue(0);
    createMock.mockRejectedValue(new Error('db blip'));

    await expect(createFeedback(input)).rejects.toThrow('db blip');
    expect(decrByMock).not.toHaveBeenCalled();
  });

  it('writes the row when the counter is under the hourly cap', async () => {
    incrByMock.mockResolvedValue(FEEDBACK_RATE_LIMIT.max - 1);

    await expect(createFeedback(input)).resolves.toEqual({ id: 1 });
    expect(createMock).toHaveBeenCalledTimes(1);
    // A refund on the SUCCESS path decrements every write back out, so the
    // counter never climbs and the cap never fires.
    expect(decrByMock).not.toHaveBeenCalled();
    expect(incrByMock).toHaveBeenCalledWith(RATE_LIMIT_KEY, 1);
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

    it('records the degrade, so the weaker path is not silent', async () => {
      countMock.mockResolvedValue(0);

      await createFeedback(input);

      expect(logToAxiomMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'feedback-rate-limit-degraded' })
      );
    });

    it('still rejects at the cap', async () => {
      countMock.mockResolvedValue(FEEDBACK_RATE_LIMIT.max);

      await expect(createFeedback(input)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(createMock).not.toHaveBeenCalled();
    });
  });
});
