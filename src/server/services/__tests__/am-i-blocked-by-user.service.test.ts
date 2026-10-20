import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserPreferences from '~/server/services/user-preferences.service';

// `amIBlockedByUser` runs on every logged-in detail view. It answers from the
// `BlockedByUsers` cache, which the block toggle invalidates for the blocked user.
// It used to also query `userEngagement` on every cache miss, which only caught a
// missed invalidation; that query is gone.

const { getCached } = vi.hoisted(() => ({
  getCached: vi.fn(async (..._a: unknown[]): Promise<{ id: number; username: string }[]> => []),
}));

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const actual = await importOriginal<typeof UserPreferences>();
  return {
    ...actual,
    BlockedByUsers: { ...actual.BlockedByUsers, getCached },
  };
});

import { amIBlockedByUser } from '~/server/services/user.service';

const VIEWER = 101;
const BLOCKER = 202;
const OTHER = 303;

beforeEach(() => {
  vi.clearAllMocks();
  getCached.mockResolvedValue([]);
  // If anything still queried the table, this row would say "blocked" — so a
  // returned `false` below can only come from the cache.
  dbMock.dbRead.userEngagement.findFirst.mockResolvedValue({
    userId: BLOCKER,
    targetUserId: VIEWER,
    type: 'Block',
  });
});

describe('amIBlockedByUser', () => {
  it('returns true when the target is in the viewer’s cached blocked-by list', async () => {
    getCached.mockResolvedValue([{ id: BLOCKER, username: 'blocker' }]);

    await expect(amIBlockedByUser({ userId: VIEWER, targetUserId: BLOCKER })).resolves.toBe(true);
    expect(getCached).toHaveBeenCalledWith({ userId: VIEWER });
  });

  it('returns false for a pair not in the cache, without querying userEngagement', async () => {
    getCached.mockResolvedValue([{ id: OTHER, username: 'other' }]);

    await expect(amIBlockedByUser({ userId: VIEWER, targetUserId: BLOCKER })).resolves.toBe(false);
    expect(dbMock.dbRead.userEngagement.findFirst).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userEngagement.findFirst).not.toHaveBeenCalled();
  });

  it('never reports a user as blocked by themselves, even if the cache lists them', async () => {
    getCached.mockResolvedValue([{ id: VIEWER, username: 'viewer' }]);

    await expect(amIBlockedByUser({ userId: VIEWER, targetUserId: VIEWER })).resolves.toBe(false);
  });

  it('returns false with no target', async () => {
    await expect(amIBlockedByUser({ userId: VIEWER })).resolves.toBe(false);
    expect(getCached).not.toHaveBeenCalled();
  });

  it('resolves a username to an id and answers from the cache', async () => {
    getCached.mockResolvedValue([{ id: BLOCKER, username: 'blocker' }]);
    dbMock.dbRead.user.findFirst.mockResolvedValueOnce({ id: BLOCKER });

    await expect(amIBlockedByUser({ userId: VIEWER, targetUsername: 'blocker' })).resolves.toBe(
      true
    );
    expect(dbMock.dbRead.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: 'blocker' } })
    );
    expect(dbMock.dbRead.userEngagement.findFirst).not.toHaveBeenCalled();
  });

  it('returns false for an unknown username', async () => {
    getCached.mockResolvedValue([{ id: BLOCKER, username: 'blocker' }]);
    dbMock.dbRead.user.findFirst.mockResolvedValueOnce(null);

    await expect(amIBlockedByUser({ userId: VIEWER, targetUsername: 'nobody' })).resolves.toBe(
      false
    );
    // An unresolved username is answered before the cache is read.
    expect(getCached).not.toHaveBeenCalled();
  });
});
