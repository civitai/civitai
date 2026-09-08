import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { userFollowsCache } from '~/server/redis/caches';

/**
 * Neither `deleteUser` nor the three indexes filters on `deletedAt`, so without this
 * fan-out the account's documents keep an avatar `remove-deleted-user-images` later
 * destroys.
 */

const { mockQueueOwnerAvatarReindex } = vi.hoisted(() => ({
  mockQueueOwnerAvatarReindex: vi.fn(),
}));

vi.mock('~/server/services/owner-avatar-index', () => ({
  queueOwnerAvatarReindex: mockQueueOwnerAvatarReindex,
}));

import * as UserService from '~/server/services/user.service';

const USER_ID = 42;

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
  dbMock.dbWrite.userEngagement.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.$transaction.mockImplementation(async (ops: unknown) => ops);
  vi.spyOn(userFollowsCache, 'bust').mockResolvedValue(undefined);
  mockQueueOwnerAvatarReindex.mockResolvedValue({});
});

describe('deleteUser — the avatar left behind', () => {
  it('rebuilds the documents that denormalize the deleted account’s avatar', async () => {
    await deleteUser();

    expect(mockQueueOwnerAvatarReindex).toHaveBeenCalledWith({
      userId: USER_ID,
      source: 'user-delete',
    });
  });

  // The enqueue only records ids; `pullData` reads at drain time. Ordering matters only
  // for a drain landing between the enqueue and the commit.
  it('queues only after the transaction has nulled profilePictureId', async () => {
    await deleteUser();

    const [{ order: transactionOrder }] = dbMock.dbWrite.$transaction.mock.invocationCallOrder.map(
      (order: number) => ({ order })
    );
    expect(mockQueueOwnerAvatarReindex.mock.invocationCallOrder[0]).toBeGreaterThan(
      transactionOrder
    );
  });
  // The delete has already committed here, and `invalidateSession` runs below. A throw
  // would leave a closed account with a live session and a running subscription — so the
  // call site guards rather than trusting the callee's contract from another file.
  it('completes the deletion even if the rebuild throws', async () => {
    mockQueueOwnerAvatarReindex.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(deleteUser()).resolves.toBeDefined();
  });
});
