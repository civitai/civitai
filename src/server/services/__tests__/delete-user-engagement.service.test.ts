import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { userFollowsCache } from '~/server/redis/caches';

/**
 * 868kurkcf. `deleteUser` meant to clear the account's `UserEngagement` rows and its
 * predicate was `OR: [{ userId, targetUserId }]` — ONE OR element carrying two
 * fields, which is a single ANDed predicate (`userId = X AND targetUserId = X`) and
 * matches only a self-engagement row. `deleteUser` soft-deletes the User row, so no
 * FK cascade covered for it: every follow, hide and block belonging to or aimed at a
 * deleted account survived, and `getUserList` kept counting them. That is the
 * "deleted people are still in my followers list" complaint.
 */

import * as UserService from '~/server/services/user.service';

const USER_ID = 42;
const engagement = dbMock.dbWrite.userEngagement;

const deleteUser = () =>
  UserService.deleteUser({ id: USER_ID, username: 'gone' } as Parameters<
    typeof UserService.deleteUser
  >[0]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: USER_ID, meta: {} });
  dbMock.dbWrite.user.update.mockResolvedValue({});
  dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.account.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.session.deleteMany.mockResolvedValue({ count: 0 });
  engagement.deleteMany.mockResolvedValue({ count: 0 });
  // The array form: prisma builds every element BEFORE the transaction runs, so the
  // delegate calls have already happened by the time this resolves.
  dbMock.dbWrite.$transaction.mockImplementation(async (ops: unknown) => ops);
});

describe('deleteUser — the engagement predicate', () => {
  it('removes engagements in BOTH directions, not their intersection', async () => {
    vi.spyOn(userFollowsCache, 'bust').mockResolvedValue(undefined);

    await deleteUser();

    // Two OR elements. One element carrying both fields is the bug: assert the
    // SHAPE, because `expect.objectContaining({ OR: expect.anything() })` passes over
    // the broken predicate unchanged.
    expect(engagement.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: USER_ID }, { targetUserId: USER_ID }] },
    });
  });

  it("drops the deleted user's own cached follow set", async () => {
    const bust = vi.spyOn(userFollowsCache, 'bust').mockResolvedValue(undefined);

    await deleteUser();

    // The rows are gone for real now. Their FOLLOWERS' entries are deliberately left
    // to their own TTL — a popular account has six figures of them, and each holds an
    // id whose content this same call has already removed.
    expect(bust).toHaveBeenCalledWith(USER_ID);
  });
});
