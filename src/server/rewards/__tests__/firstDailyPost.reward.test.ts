import { beforeEach, describe, expect, it, vi } from 'vitest';

// The reward module loads `../base.reward`, which builds a buzz client, redis
// handles and prom collectors at import time. Mocked to the surface base.reward
// touches so this suite can collect; only `$query` is under test.
const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: (...args: unknown[]) => h.query(...args) },
}));
vi.mock('~/server/redis/client', () => ({ redis: {}, REDIS_KEYS: { BUZZ_EVENTS: 'buzz-events' } }));
vi.mock('~/server/prom/client', () => ({
  rewardFailedCounter: { inc: vi.fn() },
  rewardGivenCounter: { inc: vi.fn() },
  clickhouseFailSoftCounter: { inc: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: vi.fn(),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));

import { getFirstDailyPostRewardedIds } from '~/server/rewards/active/firstDailyPost.reward';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// `$query` is a tagged template, so the mock sees (parts, ...values).
const lastQuery = () => {
  const [parts, ...values] = h.query.mock.calls.at(-1) as unknown as [string[], ...unknown[]];
  return parts.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '');
};

beforeEach(() => {
  vi.clearAllMocks();
  h.query.mockResolvedValue([]);
});

describe('getFirstDailyPostRewardedIds', () => {
  it('returns the post ids ClickHouse reports an award for', async () => {
    h.query.mockResolvedValue([{ forId: 2 }, { forId: 2 }]);
    const rewarded = await getFirstDailyPostRewardedIds([
      { id: 1, userId: 10 },
      { id: 2, userId: 20 },
    ]);
    expect([...rewarded]).toEqual([2]);
  });

  // buzzEvents is ordered by (type, toUserId, forId, byUserId), so matching on
  // forId alone drops the index: measured 124MiB read against 24MiB for the pair.
  it('matches on the (user, post) pair so the primary key still applies', async () => {
    await getFirstDailyPostRewardedIds([
      { id: 1, userId: 10 },
      { id: 2, userId: 20 },
    ]);
    expect(lastQuery()).toContain('(toUserId, forId) IN ((10,1),(20,2))');
  });

  // A capped event means the user's cap was already spent that day by another
  // post; it is not a payment, and treating it as one would skip a legitimate grant.
  it('counts awarded events only', async () => {
    await getFirstDailyPostRewardedIds([{ id: 1, userId: 10 }]);
    expect(lastQuery()).toContain("status = 'awarded'");
  });

  it('does not query for an empty post set', async () => {
    expect([...(await getFirstDailyPostRewardedIds([]))]).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });
});
