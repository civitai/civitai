import { describe, it, expect, vi, beforeEach } from 'vitest';

// An image's vote tally holds only its open round. A tally rebuilt after a cache miss counts only
// votes still Pending, and an image leaving the queues has its tally dropped.

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: mockQuery } }));

import { clearImageRatings, getImageRatingsCounter } from '~/server/games/new-order/utils';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { NewOrderImageRatingStatus } from '~/server/common/enums';

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.zScore.mockResolvedValue(null); // cache miss: the tally is rebuilt
});

describe('image ratings tally', () => {
  it('a rebuilt tally counts only votes still Pending', async () => {
    const vote = (rating: number, status: string) => ({ rank: 'Knight', rating, status, count: 1 });
    mockQuery.mockResolvedValue([
      vote(1, NewOrderImageRatingStatus.Pending),
      vote(1, NewOrderImageRatingStatus.Pending),
      vote(1, NewOrderImageRatingStatus.Correct),
      vote(1, NewOrderImageRatingStatus.Failed),
      vote(1, NewOrderImageRatingStatus.Inconclusive),
      vote(4, NewOrderImageRatingStatus.Correct),
    ]);

    const counter = getImageRatingsCounter(7);

    expect(await counter.getCount('Knight-1')).toBe(2);
    expect(await counter.getCount('Knight-4')).toBe(0);
  });

  it('clearImageRatings drops the tally of every image given', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);

    await clearImageRatings(ids);

    const deleted = redisMock.sysRedis.del.mock.calls.map(([key]) => key);
    expect(deleted).toHaveLength(150);
    expect(new Set(deleted)).toEqual(
      new Set(ids.map((id) => `${REDIS_SYS_KEYS.NEW_ORDER.RATINGS}:${id}`))
    );
  });

  it('clearImageRatings with no images touches nothing', async () => {
    await clearImageRatings([]);

    expect(redisMock.sysRedis.del).not.toHaveBeenCalled();
  });
});
