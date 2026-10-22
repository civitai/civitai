import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbWrite = dbMock.dbWrite;

const { mockStripe, mockCreateNotification } = vi.hoisted(() => ({
  mockStripe: {
    subscriptions: { retrieve: vi.fn(), del: vi.fn(), deleteDiscount: vi.fn() },
    coupons: { del: vi.fn() },
    checkout: { sessions: { retrieve: vi.fn() } },
    paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
    customers: { retrieveCashBalance: vi.fn() },
    refunds: { create: vi.fn() },
  },
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: vi.fn().mockResolvedValue(mockStripe),
}));
vi.mock('~/server/services/stripe.service', () => ({ createCustomer: vi.fn() }));
vi.mock('~/server/services/subscriptions.service', () => ({ getPlans: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/email/templates/membershipGiftReceived.email', () => ({
  membershipGiftReceivedEmail: { send: vi.fn() },
}));
vi.mock('~/server/email/templates/membershipGiftSent.email', () => ({
  membershipGiftSentEmail: { send: vi.fn() },
}));
vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/utils/url-helpers', () => ({ getBaseUrl: () => 'https://civitai.com' }));
vi.mock('~/server/utils/errorHandling', () => ({
  throwBadRequestError: (message: string) => {
    throw new Error(message);
  },
  throwNotFoundError: (message: string) => {
    throw new Error(message);
  },
}));

import {
  refundUnfulfilledMembershipGift,
  revokeMembershipGift,
  revokeUnpaidMembershipGift,
} from '~/server/services/membership-gift.service';

// A bank-transfer gift that was granted on checkout completion and whose money never came: the
// holder is on the residual subscription the gift minted.
const unpaidGift = {
  id: 'gift_1',
  gifterId: 1,
  recipientId: 2,
  holderId: 2,
  tier: 'bronze',
  months: 1,
  status: 'Completed',
  monthsRemaining: 0,
  monthsConsumed: 1,
  armedCouponId: null,
  stripeCheckoutSessionId: 'cs_1',
  stripePaymentIntentId: 'pi_1',
  stripeCouponId: null,
  stripeSubscriptionId: 'sub_residual',
};

const transferIntent = (over: Record<string, unknown> = {}) => ({
  id: 'pi_1',
  status: 'requires_action',
  amount: 1000,
  amount_received: 0,
  currency: 'usd',
  customer: 'cus_1',
  payment_method_types: ['customer_balance'],
  metadata: { giftId: 'gift_1' },
  next_action: {
    type: 'display_bank_transfer_instructions',
    display_bank_transfer_instructions: { amount_remaining: 1000 },
  },
  ...over,
});

const residualSub = {
  id: 'sub_residual',
  status: 'active',
  cancel_at: 1800000000,
  metadata: { membershipGiftId: 'gift_1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...unpaidGift });
  mockDbWrite.membershipGift.update.mockResolvedValue({});
  mockStripe.paymentIntents.retrieve.mockResolvedValue(transferIntent());
  mockStripe.paymentIntents.cancel.mockResolvedValue({ id: 'pi_1', status: 'canceled' });
  mockStripe.customers.retrieveCashBalance.mockResolvedValue({ available: null });
  mockStripe.subscriptions.retrieve.mockResolvedValue(residualSub);
  mockStripe.subscriptions.del.mockResolvedValue({});
  mockStripe.coupons.del.mockResolvedValue({});
});

const revokedStatusWrite = () =>
  mockDbWrite.membershipGift.update.mock.calls.find(([args]) => args.data?.status === 'Failed');

describe('revokeUnpaidMembershipGift', () => {
  it('a dry run reports what the holder loses and changes nothing', async () => {
    const result = await revokeUnpaidMembershipGift({ giftId: 'gift_1' });

    expect(result).toEqual({
      outcome: 'would-revoke',
      paymentIntentId: 'pi_1',
      paymentStatus: 'requires_action',
      selfGift: false,
      effect: {
        kind: 'residual-subscription-ends',
        subscriptionId: 'sub_residual',
        cancelAt: 1800000000,
      },
      notified: false,
    });
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.del).not.toHaveBeenCalled();
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });

  it('cancels the payment BEFORE revoking, so a late transfer cannot clear for a revoked gift', async () => {
    const result = await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result.outcome).toBe('revoked');
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_1', {
      cancellation_reason: 'abandoned',
    });
    expect(mockStripe.subscriptions.del).toHaveBeenCalledWith('sub_residual');
    const statusWrite = revokedStatusWrite();
    expect(statusWrite?.[0].where).toEqual({ id: 'gift_1' });
    const cancelOrder = mockStripe.paymentIntents.cancel.mock.invocationCallOrder[0];
    const revokeOrder = mockStripe.subscriptions.del.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(revokeOrder);
  });

  it('revokes nothing when Stripe refuses the cancel (the payment started to clear)', async () => {
    mockStripe.paymentIntents.cancel.mockRejectedValue(
      new Error('payment_intent_unexpected_state')
    );

    await expect(revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true })).rejects.toThrow(
      'payment_intent_unexpected_state'
    );
    expect(mockStripe.subscriptions.del).not.toHaveBeenCalled();
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });

  it.each([
    ['succeeded', 'payment-succeeded'],
    ['processing', 'payment-processing'],
  ])('skips a gift whose payment is now %s, touching nothing', async (status, reason) => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue(transferIntent({ status }));

    const result = await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result).toEqual({ outcome: 'skipped', reason, paymentStatus: status });
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });

  it('stops on a partly funded bank transfer', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue(
      transferIntent({
        next_action: {
          type: 'display_bank_transfer_instructions',
          display_bank_transfer_instructions: { amount_remaining: 400 },
        },
      })
    );

    const result = await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result).toEqual({
      outcome: 'stopped',
      reason: 'partially-funded',
      paymentIntentId: 'pi_1',
    });
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });

  it('stops when money sits unapplied in the customer cash balance', async () => {
    mockStripe.customers.retrieveCashBalance.mockResolvedValue({ available: { usd: 1000 } });

    const result = await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result).toEqual({
      outcome: 'stopped',
      reason: 'unapplied-cash-balance',
      paymentIntentId: 'pi_1',
    });
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('skips a payment that does not belong to this gift', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue(
      transferIntent({ metadata: { giftId: 'gift_other' } })
    );

    const result = await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'payment-mismatch' });
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('is a no-op on a re-run after the gift was revoked', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...unpaidGift, status: 'Failed' });

    const result = await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result).toEqual({ outcome: 'already-revoked', status: 'Failed' });
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('finishes a gift whose payment was cancelled by an earlier, interrupted run', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue(transferIntent({ status: 'canceled' }));

    const result = await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result.outcome).toBe('revoked');
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(revokedStatusWrite()).toBeDefined();
  });

  it('notifies the holder only when asked and only when they lose something live', async () => {
    await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true });
    expect(mockCreateNotification).not.toHaveBeenCalled();

    await revokeUnpaidMembershipGift({ giftId: 'gift_1', execute: true, notify: true });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0][0]).toMatchObject({
      type: 'membership-gift-canceled',
      userId: 2,
      key: 'membership-gift-canceled:gift_1',
      details: { selfGift: false },
    });

    mockCreateNotification.mockClear();
    mockStripe.subscriptions.retrieve.mockResolvedValue({ ...residualSub, status: 'canceled' });
    const result = await revokeUnpaidMembershipGift({
      giftId: 'gift_1',
      execute: true,
      notify: true,
    });
    expect(result).toMatchObject({ effect: { kind: 'nothing-live' }, notified: false });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('refundUnfulfilledMembershipGift', () => {
  const paidPendingGift = {
    ...unpaidGift,
    status: 'Pending',
    monthsConsumed: 0,
    stripeSubscriptionId: null,
  };
  const paidIntent = (charge: Record<string, unknown>) =>
    transferIntent({
      status: 'succeeded',
      payment_method_types: ['card'],
      next_action: null,
      latest_charge: { id: 'ch_1', currency: 'usd', amount_refunded: 0, ...charge },
    });

  beforeEach(() => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...paidPendingGift });
    mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });
  });

  it("refunds the charge's own unrefunded amount, not a typed one", async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue(
      paidIntent({ amount_captured: 1000, amount_refunded: 300 })
    );

    const dry = await refundUnfulfilledMembershipGift({ giftId: 'gift_1' });
    expect(dry).toMatchObject({ outcome: 'would-refund', amount: 700, chargeId: 'ch_1' });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();

    const result = await refundUnfulfilledMembershipGift({ giftId: 'gift_1', execute: true });
    expect(result).toMatchObject({ outcome: 'refunded', amount: 700, refundId: 're_1' });
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_1', amount: 700, metadata: { giftId: 'gift_1' } },
      { idempotencyKey: 'membership-gift-refund:gift_1:ch_1:700' }
    );
  });

  it('names the payment on the row first, so the refund webhook can find the gift', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...paidPendingGift,
      stripePaymentIntentId: null,
    });
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({ payment_intent: 'pi_1' });
    mockStripe.paymentIntents.retrieve.mockResolvedValue(paidIntent({ amount_captured: 1000 }));

    await refundUnfulfilledMembershipGift({ giftId: 'gift_1', execute: true });

    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith({
      where: { id: 'gift_1' },
      data: { stripePaymentIntentId: 'pi_1' },
    });
    expect(mockDbWrite.membershipGift.update.mock.invocationCallOrder[0]).toBeLessThan(
      mockStripe.refunds.create.mock.invocationCallOrder[0]
    );
  });

  it('refunds nothing when the charge is already fully refunded', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue(
      paidIntent({ amount_captured: 1000, amount_refunded: 1000 })
    );

    const result = await refundUnfulfilledMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result).toEqual({ outcome: 'skipped', reason: 'nothing-refundable' });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  it('refuses a gift that was fulfilled', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...unpaidGift });

    const result = await refundUnfulfilledMembershipGift({ giftId: 'gift_1', execute: true });

    expect(result).toEqual({ outcome: 'skipped', reason: 'not-pending', status: 'Completed' });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  // The refund itself only moves money; the gift is marked by the `charge.refunded` webhook, which
  // finds it by payment. This is that webhook's call on a never-fulfilled gift.
  it('the charge.refunded webhook marks a Pending gift Refunded', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...paidPendingGift });

    expect(await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' })).toBe(true);

    expect(mockDbWrite.membershipGift.findUnique).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: 'pi_1' },
    });
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'Refunded' }) })
    );
  });
});
