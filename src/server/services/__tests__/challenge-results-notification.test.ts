import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(async (..._a: unknown[]) => undefined),
  mockDb: {
    challenge: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ collectionId: 5 })) },
    challengeEngagement: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown> => []) },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mocks.mockDb, dbWrite: mocks.mockDb }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/services/challenge-block.service', () => ({
  getChallengeExcludedUserIds: vi.fn(async () => []),
}));

import { sendChallengeResultsNotification } from '~/server/services/challenge-engagement.service';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockDb.challenge.findUnique.mockResolvedValue({ collectionId: 5 });
});

describe('sendChallengeResultsNotification', () => {
  it('notifies trackers and entrants who are not already covered by a winner notification', async () => {
    mocks.mockDb.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }]);
    mocks.mockDb.$queryRaw.mockResolvedValueOnce([{ userId: 3 }, { userId: 4 }]);

    await sendChallengeResultsNotification({
      challengeId: 7,
      challengeTitle: 'Neon Dreams',
      excludeUserIds: [2, 4],
    });

    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    const arg = mocks.createNotification.mock.calls[0][0] as { userIds: number[]; key: string };
    expect([...arg.userIds].sort((a, b) => a - b)).toEqual([1, 3]);
    expect(arg.key).toBe('challenge-results:7');
  });

  it('sends nothing when every recipient already got a winner notification', async () => {
    mocks.mockDb.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }]);
    mocks.mockDb.$queryRaw.mockResolvedValueOnce([]);

    await sendChallengeResultsNotification({
      challengeId: 7,
      challengeTitle: 'Neon Dreams',
      excludeUserIds: [1],
    });

    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('excludes a participation-prize earner passed in excludeUserIds, even though they are not a winner', async () => {
    // Pool: tracker 1, entrants 2 and 9. excludeUserIds carries winner 5 (not in the pool at all)
    // plus 9 — standing in for a participation-prize earner, who is neither a winner nor a
    // tracker-only user, but must still be excluded since callers merge both into excludeUserIds.
    mocks.mockDb.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }]);
    mocks.mockDb.$queryRaw.mockResolvedValueOnce([{ userId: 2 }, { userId: 9 }]);

    await sendChallengeResultsNotification({
      challengeId: 7,
      challengeTitle: 'Neon Dreams',
      excludeUserIds: [5, 9],
    });

    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: [1, 2] })
    );
  });

  it('swallows a failure so completion is never blocked by a notification', async () => {
    mocks.mockDb.challengeEngagement.findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(
      sendChallengeResultsNotification({
        challengeId: 7,
        challengeTitle: 'Neon Dreams',
        excludeUserIds: [],
      })
    ).resolves.not.toThrow();
  });
});
