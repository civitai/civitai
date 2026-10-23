import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SubscriptionUtils from '~/server/utils/subscription.utils';

/**
 * A declined first payment leaves the subscription `incomplete` with its Checkout Session open,
 * and Stripe refuses to delete a subscription in that state. The member then could not cancel at
 * all: the request failed and the incomplete subscription stayed.
 */

const { stripe, invalidateSubscriptionCaches } = vi.hoisted(() => ({
  stripe: {
    subscriptions: { list: vi.fn(), del: vi.fn(), retrieve: vi.fn() },
    billingPortal: { sessions: { create: vi.fn() } },
    checkout: { sessions: { list: vi.fn(), expire: vi.fn() } },
  },
  invalidateSubscriptionCaches: vi.fn(),
}));

vi.mock('~/server/utils/get-server-stripe', () => ({ getServerStripe: async () => stripe }));
vi.mock('~/server/utils/subscription.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionUtils>()),
  invalidateSubscriptionCaches,
}));

import { cancelSubscriptionWithFallback } from '~/server/services/stripe.service';

const USER_ID = 42;
const SUB_ID = 'sub_incomplete';
const row = dbMock.dbWrite.customerSubscription;

const openCheckoutRefusal = () =>
  Object.assign(
    new Error(
      'You cannot cancel a subscription with an active checkout session. Expire the checkout session instead.'
    ),
    { rawType: 'invalid_request_error' }
  );

const cancel = () => cancelSubscriptionWithFallback({ customerId: 'cus_1', userId: USER_ID });

beforeEach(() => {
  vi.resetAllMocks();
  // The portal flow fails, so the direct-cancel fallback runs.
  stripe.subscriptions.list.mockResolvedValue({ data: [{ id: SUB_ID, status: 'incomplete' }] });
  stripe.billingPortal.sessions.create.mockRejectedValue(new Error('portal failed'));
  stripe.checkout.sessions.list.mockResolvedValue({ data: [] });
  stripe.checkout.sessions.expire.mockResolvedValue({});
  row.findFirst.mockResolvedValue({ id: SUB_ID });
  row.delete.mockResolvedValue({ id: SUB_ID });
});

describe('cancelSubscriptionWithFallback — incomplete subscription with an open checkout', () => {
  it('expires the open session, deletes the subscription, and drops our row', async () => {
    stripe.subscriptions.del.mockRejectedValueOnce(openCheckoutRefusal()).mockResolvedValue({});
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [
        { id: 'cs_old', status: 'expired', subscription: SUB_ID },
        // An open session for a different subscription is never ours to expire.
        { id: 'cs_other', status: 'open', subscription: 'sub_other' },
        { id: 'cs_open', status: 'open', subscription: SUB_ID },
      ],
    });

    await expect(cancel()).resolves.toEqual({ type: 'direct' });

    expect(stripe.checkout.sessions.list).toHaveBeenCalledWith(
      { subscription: SUB_ID, limit: 10 },
      undefined
    );
    expect(stripe.checkout.sessions.expire.mock.calls).toEqual([['cs_open', {}, undefined]]);
    expect(stripe.subscriptions.del).toHaveBeenCalledTimes(2);
    expect(row.delete).toHaveBeenCalledWith({ where: { id: SUB_ID } });
    expect(invalidateSubscriptionCaches).toHaveBeenCalledWith(USER_ID);
  });

  it('succeeds when expiring the session already ended the subscription', async () => {
    stripe.subscriptions.del.mockRejectedValue(openCheckoutRefusal());
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [{ id: 'cs_open', status: 'open', subscription: SUB_ID }],
    });
    stripe.subscriptions.retrieve.mockResolvedValue({ id: SUB_ID, status: 'incomplete_expired' });

    await expect(cancel()).resolves.toEqual({ type: 'direct' });
    expect(row.delete).toHaveBeenCalledWith({ where: { id: SUB_ID } });
  });

  it('still fails, keeping our row, when the retry fails and the subscription is live', async () => {
    stripe.subscriptions.del.mockRejectedValue(openCheckoutRefusal());
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [{ id: 'cs_open', status: 'open', subscription: SUB_ID }],
    });
    stripe.subscriptions.retrieve.mockResolvedValue({ id: SUB_ID, status: 'incomplete' });

    await expect(cancel()).rejects.toThrow('active checkout session');
    expect(row.delete).not.toHaveBeenCalled();
  });
});

describe('cancelSubscriptionWithFallback — the guards around the expire', () => {
  it('a failed expire (the member just paid) stops the cancel: no second delete, no success', async () => {
    // Expiring a session that completed a moment ago fails. Swallowing that failure would delete
    // a subscription the member has just paid for.
    stripe.subscriptions.del.mockRejectedValueOnce(openCheckoutRefusal()).mockResolvedValue({});
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [{ id: 'cs_open', status: 'open', subscription: SUB_ID }],
    });
    stripe.checkout.sessions.expire.mockRejectedValue(
      new Error('This Checkout Session is already complete')
    );
    stripe.subscriptions.retrieve.mockResolvedValue({ id: SUB_ID, status: 'canceled' });

    await expect(cancel()).rejects.toThrow('already complete');
    expect(stripe.subscriptions.del).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(row.delete).not.toHaveBeenCalled();
  });

  it('a failed session lookup surfaces the ORIGINAL refusal, not the lookup error', async () => {
    const refusal = openCheckoutRefusal();
    stripe.subscriptions.del.mockRejectedValue(refusal);
    stripe.checkout.sessions.list.mockRejectedValue(new Error('list failed'));

    await expect(cancel()).rejects.toBe(refusal);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(stripe.subscriptions.del).toHaveBeenCalledTimes(1);
  });
});

describe('cancelSubscriptionWithFallback — controls: paths without an open checkout are unchanged', () => {
  it('an active subscription is deleted once, and no checkout session is looked up or expired', async () => {
    stripe.subscriptions.del.mockResolvedValue({ id: SUB_ID, status: 'canceled' });

    await expect(cancel()).resolves.toEqual({ type: 'direct' });

    // DECISION: the options argument stays undefined, never `{}`. The real stripe-node rejects an
    // empty options object ("Stripe: Unknown arguments") before sending, which this mock would not.
    expect(stripe.subscriptions.del).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.del.mock.calls[0][0]).toBe(SUB_ID);
    expect(stripe.subscriptions.del.mock.calls[0][2]).not.toEqual({});
    expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it('a refusal with no open session rethrows the original error and expires nothing', async () => {
    const refusal = Object.assign(new Error('some other refusal'), {
      rawType: 'invalid_request_error',
    });
    stripe.subscriptions.del.mockRejectedValue(refusal);
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [{ id: 'cs_done', status: 'complete', subscription: SUB_ID }],
    });

    await expect(cancel()).rejects.toBe(refusal);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(stripe.subscriptions.del).toHaveBeenCalledTimes(1);
    expect(row.delete).not.toHaveBeenCalled();
  });

  it('a non-request error (network, auth) never looks for sessions', async () => {
    stripe.subscriptions.del.mockRejectedValue(
      Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' })
    );

    await expect(cancel()).rejects.toThrow('connection reset');
    expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
  });
});
