import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  checkSharedAppendRateLimit,
  checkSharedReportRateLimit,
  checkSharedVoteRateLimit,
  checkSharedWithdrawRateLimit,
} from '~/server/utils/shared-storage-rate-limit';

/** The refusal's retry metadata, and the fail-open contract, across the four shared buckets. */

// Fixtures deliberately unlike the production windows (60s / 24h) and caps (20 / 30).
const NOW = Date.parse('2030-02-03T04:05:06.000Z');
const TTL_SECONDS = 17;
const OVER_ANY_CAP = 9_999;

const CHECKS = [
  { name: 'append', check: checkSharedAppendRateLimit },
  { name: 'vote', check: checkSharedVoteRateLimit },
  { name: 'withdraw', check: checkSharedWithdrawRateLimit },
  { name: 'report', check: checkSharedReportRateLimit },
];

beforeEach(() => {
  resetSharedMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shared-storage rate-limit refusal', () => {
  it.each(CHECKS)('$name: retryAt is now + the bucket TTL, as ISO-8601', async ({ check }) => {
    redisMock.redis.incrBy.mockResolvedValue(OVER_ANY_CAP);
    redisMock.redis.ttl.mockResolvedValue(TTL_SECONDS);

    await expect(check(7, 'apb_fixture')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: TTL_SECONDS,
      retryAt: '2030-02-03T04:05:23.000Z',
    });
  });
});

describe('INVARIANT GUARD (not regression coverage): the limiter still fails open', () => {
  it.each(CHECKS)('$name: a redis error allows the write', async ({ check }) => {
    redisMock.redis.incrBy.mockRejectedValue(new Error('redis down'));
    await expect(check(7, 'apb_fixture')).resolves.toEqual({ allowed: true });
  });
});
