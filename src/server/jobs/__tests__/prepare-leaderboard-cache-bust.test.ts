import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/db/pgDb', () => {
  const empty = async () => ({ rows: [] });
  return {
    pgDbRead: { query: empty },
    pgDbReadLong: {
      query: empty,
      cancellableQuery: async () => ({ result: async () => [], cancel: async () => undefined }),
    },
    pgDbWrite: {
      query: empty,
      cancellableQuery: async () => ({ result: async () => [], cancel: async () => undefined }),
    },
  };
});
vi.mock('~/server/jobs/apply-discord-roles', () => ({ applyDiscordLeaderboardRoles: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: vi.fn(async () => []),
}));
vi.mock('~/server/services/leaderboard.service', () => ({
  getUnpopulatedLeaderboards: vi.fn(),
  isLeaderboardPopulated: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { leaderboardJobs } from '../prepare-leaderboard';

const prepareLeaderboard = leaderboardJobs.find((j) => j.name === 'prepare-leaderboard')!;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.leaderboard.findMany.mockResolvedValue([] as never);
});

// On 2026-10-19 the job was re-run after midnight. The boards were rebuilt, but the routers kept
// serving the empty boards they had cached at midnight until the cache was purged by hand.
describe('prepare-leaderboard cache bust', () => {
  it('purges the leaderboard cache tag once the boards are built', async () => {
    await prepareLeaderboard.run({}).result;

    expect(redisMock.redis.purgeTags).toHaveBeenCalledWith('leaderboard');
  });

  it('leaves the cache alone when the run fails', async () => {
    dbMock.dbWrite.leaderboard.findMany.mockRejectedValue(new Error('db down') as never);

    await expect(prepareLeaderboard.run({}).result).rejects.toThrow('db down');

    expect(redisMock.redis.purgeTags).not.toHaveBeenCalled();
  });
});
