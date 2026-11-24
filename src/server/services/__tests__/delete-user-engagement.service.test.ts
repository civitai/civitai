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
    // the broken predicate unchanged. The `type` exclusion is asserted here too, so
    // dropping either half fails.
    expect(engagement.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ userId: USER_ID }, { targetUserId: USER_ID }],
        type: { not: 'Block' },
      },
    });
  });

  it('leaves BLOCKS standing, in both directions', async () => {
    vi.spyOn(userFollowsCache, 'bust').mockResolvedValue(undefined);

    await deleteUser();

    // Account deletion is reversible (`restoreUser`) and nothing restores
    // engagements, so clearing a Block would switch off a safety control its owner
    // set — someone else's — with no event telling them. Asserted separately from the
    // predicate above so the reason survives a refactor of the shape.
    const [{ where }] = engagement.deleteMany.mock.calls[0] as [{ where: { type: unknown } }];
    expect(where.type).toEqual({ not: 'Block' });
  });

  it('busts the follow cache AFTER the transaction commits, not before', async () => {
    const bust = vi.spyOn(userFollowsCache, 'bust').mockResolvedValue(undefined);

    await deleteUser();

    // Bust first and a concurrent reader repopulates the entry from rows the
    // transaction has not deleted yet — reinstating the reported symptom through the
    // cache for a full day-long TTL, with the predicate correct.
    expect(bust.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.dbWrite.$transaction.mock.invocationCallOrder[0]
    );
  });

  it('deletes the engagements INSIDE the transaction', async () => {
    vi.spyOn(userFollowsCache, 'bust').mockResolvedValue(undefined);

    await deleteUser();

    // Pulled out of the array it stops being atomic with the user soft-delete: a
    // failure between the two leaves an account that is either deleted with its
    // engagements live, or intact with them gone.
    // Identity against the delegate's own return value — prisma builds every element
    // of the array eagerly, so what lands in it is that PROMISE, not its result.
    const [ops] = dbMock.dbWrite.$transaction.mock.calls[0] as [unknown[]];
    expect(ops).toContain(engagement.deleteMany.mock.results[0].value);
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
