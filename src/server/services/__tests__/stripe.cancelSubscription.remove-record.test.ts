import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SubscriptionUtils from '~/server/utils/subscription.utils';

/**
 * Account deletion cancels with `removeRecord`. Our CustomerSubscription row is how every
 * cancel path finds the Stripe subscription, so it may be deleted only AFTER Stripe confirms:
 * deleted first, a failed cancel leaves nothing that could find or retry it, and the
 * subscription keeps billing an account nobody can log in to.
 */

const { del, update, invalidateSubscriptionCaches } = vi.hoisted(() => ({
  del: vi.fn(),
  update: vi.fn(),
  invalidateSubscriptionCaches: vi.fn(),
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: async () => ({ subscriptions: { del, update } }),
}));
vi.mock('~/server/utils/subscription.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionUtils>()),
  invalidateSubscriptionCaches,
}));

import { cancelSubscription } from '~/server/services/stripe.service';

const USER_ID = 42;
const SUB_ID = 'sub_123';
const row = dbMock.dbWrite.customerSubscription;

beforeEach(() => {
  vi.clearAllMocks();
  row.findFirst.mockResolvedValue({ id: SUB_ID });
  row.deleteMany.mockResolvedValue({ count: 1 });
  del.mockResolvedValue({ id: SUB_ID, status: 'canceled' });
});

describe('cancelSubscription({ removeRecord })', () => {
  it('cancels at Stripe, then deletes our row, then busts the caches', async () => {
    const order: string[] = [];
    del.mockImplementation(async () => void order.push('stripe.del'));
    row.deleteMany.mockImplementation(async () => {
      order.push('row.deleteMany');
      return { count: 1 };
    });
    invalidateSubscriptionCaches.mockImplementation(async () => void order.push('caches'));

    await cancelSubscription({ userId: USER_ID, removeRecord: true });

    expect(order).toEqual(['stripe.del', 'row.deleteMany', 'caches']);
    expect(row.deleteMany).toHaveBeenCalledWith({ where: { id: SUB_ID } });
  });

  it('keeps our row when Stripe rejects the cancel', async () => {
    del.mockRejectedValue(new Error('stripe down'));

    await expect(cancelSubscription({ userId: USER_ID, removeRecord: true })).rejects.toThrow(
      'stripe down'
    );

    expect(row.deleteMany).not.toHaveBeenCalled();
    expect(row.delete).not.toHaveBeenCalled();
  });

  it('retries transient Stripe failures, bounded so the request outlives no gateway', async () => {
    await cancelSubscription({ userId: USER_ID, removeRecord: true });

    expect(del).toHaveBeenCalledWith(SUB_ID, {}, { maxNetworkRetries: 2, timeout: 10_000 });
  });

  it('busts the subscription caches once the row is gone', async () => {
    await cancelSubscription({ userId: USER_ID, removeRecord: true });

    expect(invalidateSubscriptionCaches).toHaveBeenCalledWith(USER_ID);
  });

  it('leaves the row alone for callers that do not ask', async () => {
    await cancelSubscription({ userId: USER_ID });

    expect(del).toHaveBeenCalledTimes(1);
    expect(row.deleteMany).not.toHaveBeenCalled();
  });
});
