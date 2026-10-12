import { beforeEach, describe, expect, it } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  checkSharedReportRateLimit,
  checkSharedVoteRateLimit,
  checkSharedWithdrawRateLimit,
  SHARED_REPORT_RATE_LIMIT_WINDOW_SECONDS,
  SHARED_VOTE_RATE_LIMIT_WINDOW_SECONDS,
  SHARED_WITHDRAW_RATE_LIMIT_WINDOW_SECONDS,
} from '~/server/utils/shared-storage-rate-limit';

/**
 * INVARIANT GUARDS: the refusal's retryAfterSeconds and the fail-open contract, across the three
 * fixed-window shared buckets.
 */

// Fixtures deliberately unlike any production window or cap.
const TTL_SECONDS = 17;
const OVER_ANY_CAP = 9_999;

const CHECKS = [
  { name: 'vote', check: checkSharedVoteRateLimit, window: SHARED_VOTE_RATE_LIMIT_WINDOW_SECONDS },
  {
    name: 'withdraw',
    check: checkSharedWithdrawRateLimit,
    window: SHARED_WITHDRAW_RATE_LIMIT_WINDOW_SECONDS,
  },
  {
    name: 'report',
    check: checkSharedReportRateLimit,
    window: SHARED_REPORT_RATE_LIMIT_WINDOW_SECONDS,
  },
];

beforeEach(() => {
  resetSharedMocks();
});

describe('INVARIANT GUARD: shared-storage rate-limit refusal', () => {
  it.each(CHECKS)('$name: retryAfterSeconds is the bucket TTL', async ({ check }) => {
    redisMock.redis.incrBy.mockResolvedValue(OVER_ANY_CAP);
    redisMock.redis.ttl.mockResolvedValue(TTL_SECONDS);

    await expect(check(7, 'apb_fixture')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: TTL_SECONDS,
    });
  });

  it.each(CHECKS)('$name: a lost TTL falls back to the window', async ({ check, window }) => {
    redisMock.redis.incrBy.mockResolvedValue(OVER_ANY_CAP);
    redisMock.redis.ttl.mockResolvedValue(-1);

    await expect(check(7, 'apb_fixture')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: window,
    });
  });
});

describe('INVARIANT GUARD (not regression coverage): the limiter still fails open', () => {
  it.each(CHECKS)('$name: a redis error allows the write', async ({ check }) => {
    redisMock.redis.incrBy.mockRejectedValue(new Error('redis down'));
    await expect(check(7, 'apb_fixture')).resolves.toEqual({ allowed: true });
  });
});
