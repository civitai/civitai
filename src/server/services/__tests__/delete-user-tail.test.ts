import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as PaddleService from '~/server/services/paddle.service';
import type * as StripeService from '~/server/services/stripe.service';
import { userBasicCache, userFollowsCache } from '~/server/redis/caches';
import { usersSearchIndex } from '~/server/search-index';

/**
 * `deleteUser` commits the soft delete, then ran three unguarded awaits (follow-cache bust,
 * search-index queue, basic-data refresh) AHEAD of the subscription cancels and
 * `invalidateSession`. Any one of them throwing skipped all of those, leaving a deleted account
 * with a live subscription and a live cached session that its owner could not sign in to end.
 */

const { cancelSubscription, cancelSubscriptionPlan, invalidateSession } = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  cancelSubscriptionPlan: vi.fn(),
  invalidateSession: vi.fn(),
}));

vi.mock('~/server/services/stripe.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StripeService>()),
  cancelSubscription,
}));
vi.mock('~/server/services/paddle.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaddleService>()),
  cancelSubscriptionPlan,
}));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  invalidateSession,
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

const ALL_STEPS = ['session', 'stripe', 'follows', 'search', 'basicData', 'paddle'];

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
