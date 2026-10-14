import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as HatSync from '~/server/events/points/sync';
import type * as PaddleService from '~/server/services/paddle.service';
import type * as StripeService from '~/server/services/stripe.service';
import type * as UserRestrictionService from '~/server/services/user-restriction.service';
import { userBasicCache, userFollowsCache } from '~/server/redis/caches';
import { usersSearchIndex } from '~/server/search-index';

/**
 * `deleteUser` commits the soft delete, then ran three unguarded awaits (follow-cache bust,
 * search-index queue, basic-data refresh) AHEAD of the subscription cancels and
 * `invalidateSession`. Any one of them throwing skipped all of those, leaving a deleted account
 * with a live subscription and a live cached session that its owner could not sign in to end.
 */

const { cancelSubscription, cancelSubscriptionPlan, invalidateSession, closeRestrictions } =
  vi.hoisted(() => ({
    cancelSubscription: vi.fn(),
    cancelSubscriptionPlan: vi.fn(),
    invalidateSession: vi.fn(),
    closeRestrictions: vi.fn(),
  }));

vi.mock('~/server/services/stripe.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StripeService>()),
  cancelSubscription,
}));
vi.mock('~/server/services/paddle.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaddleService>()),
  cancelSubscriptionPlan,
}));
vi.mock('~/server/services/user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserRestrictionService>()),
  closeGenerationRestrictionsOfDeletedAccount: closeRestrictions,
}));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  invalidateSession,
}));

const hatSync = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('~/server/events/points/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof HatSync>()),
  syncOwnerEventHats: hatSync.owner,
}));

import * as UserService from '~/server/services/user.service';

const USER_ID = 42;

const deleteUser = () =>
  UserService.deleteUser({ id: USER_ID, username: 'gone' } as Parameters<
    typeof UserService.deleteUser
  >[0]);

/** Every post-commit step, in the order it ran. A step that rejects is still recorded. */
let ran: string[] = [];
const record = (step: string) => async () => void ran.push(step);

const ALL_STEPS = ['session', 'stripe', 'follows', 'search', 'basicData', 'restrictions', 'paddle'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  ran = [];
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: USER_ID, meta: {} });
  dbMock.dbWrite.user.update.mockResolvedValue({});
  dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.account.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.session.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userEngagement.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userProfile.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userLink.deleteMany.mockResolvedValue({ count: 0 });
  invalidateSession.mockImplementation(record('session'));
  cancelSubscription.mockImplementation(record('stripe'));
  cancelSubscriptionPlan.mockImplementation(record('paddle'));
  closeRestrictions.mockImplementation(record('restrictions'));
  vi.spyOn(userFollowsCache, 'bust').mockImplementation(record('follows'));
  vi.spyOn(usersSearchIndex, 'queueUpdate').mockImplementation(record('search') as never);
  vi.spyOn(userBasicCache, 'refresh').mockImplementation(record('basicData') as never);
});

describe('deleteUser — the post-commit tail is unskippable', () => {
  it('runs every step once, the session first and Paddle last', async () => {
    await deleteUser();

    // Paddle last: its client has no timeout, so anything after it could wait on a hang.
    expect(ran).toEqual(ALL_STEPS);
    expect(invalidateSession).toHaveBeenCalledWith(USER_ID, 'moderation');
    expect(cancelSubscriptionPlan).toHaveBeenCalledWith({ userId: USER_ID });
    // Update would re-index the deleted account instead of removing it.
    expect(usersSearchIndex.queueUpdate).toHaveBeenCalledWith([
      { id: USER_ID, action: SearchIndexUpdateQueueAction.Delete },
    ]);
  });

  it.each([
    ['follows', () => vi.spyOn(userFollowsCache, 'bust')],
    ['search', () => vi.spyOn(usersSearchIndex, 'queueUpdate')],
    ['basicData', () => vi.spyOn(userBasicCache, 'refresh')],
  ])('a rejecting %s step skips nothing and reports success', async (step, spy) => {
    spy().mockImplementation((async () => {
      ran.push(step);
      throw new Error('redis down');
    }) as never);

    await expect(deleteUser()).resolves.toBeDefined();

    expect(ran).toEqual(ALL_STEPS);
  });

  // The review queue hides deleted accounts, so a case left Pending is never ruled on.
  it("closes the account's pending restrictions", async () => {
    await deleteUser();

    expect(closeRestrictions).toHaveBeenCalledWith(USER_ID);
  });

  // Before the status migration is applied the write fails; a deletion must not fail with it.
  it('a failing restriction close still runs every other step and reports success', async () => {
    closeRestrictions.mockImplementation(async () => {
      ran.push('restrictions');
      throw new Error('invalid input value for enum "UserRestrictionStatus"');
    });

    await expect(deleteUser()).resolves.toBeDefined();

    expect(ran).toEqual(ALL_STEPS);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'close-pending-restrictions', userId: USER_ID })
    );
  });

  it('a failing Stripe cancel still runs every other step', async () => {
    cancelSubscription.mockImplementation(async () => {
      ran.push('stripe');
      throw new Error('stripe down');
    });

    await expect(deleteUser()).resolves.toBeDefined();

    expect(ran).toEqual(ALL_STEPS);
  });

  it('a failing session invalidation still runs every other step', async () => {
    invalidateSession.mockImplementation(async () => {
      ran.push('session');
      throw new Error('redis down');
    });

    await expect(deleteUser()).resolves.toBeDefined();

    expect(ran).toEqual(ALL_STEPS);
  });

  it('logs a swallowed Stripe failure under the name its alert already watches', async () => {
    // Once swallowed, this log line is the only trace of a deleted account still billing.
    cancelSubscription.mockRejectedValue(new Error('stripe down'));

    await deleteUser();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cancel-stripe-subscription',
        type: 'error',
        source: 'deleteUser',
        userId: USER_ID,
        message: 'stripe down',
      })
    );
  });

  it('asks Stripe to drop our subscription row only once the cancel is confirmed', async () => {
    await deleteUser();

    expect(cancelSubscription).toHaveBeenCalledWith({ userId: USER_ID, removeRecord: true });
  });
});

describe('deleteUser -> live event hats', () => {
  it('takes a deleted owner’s hats off after the delete commits', async () => {
    await deleteUser();
    expect(hatSync.owner.mock.calls).toEqual([[USER_ID]]);
    expect(hatSync.owner.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.dbWrite.$transaction.mock.invocationCallOrder[0]
    );
  });
});
