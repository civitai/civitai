import { describe, it, expect, vi, beforeEach } from 'vitest';
import dayjs from 'dayjs';

const { mockDbWrite, mockStripe, mockCreateCustomer, mockGetPlans, mockCreateNotification } =
  vi.hoisted(() => {
    const mockMembershipGift = {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    };
    const mockCustomerSubscription = {
      findUnique: vi.fn(),
    };
    const mockUser = {
      findUnique: vi.fn(),
    };

    return {
      mockDbWrite: {
        membershipGift: mockMembershipGift,
        customerSubscription: mockCustomerSubscription,
        user: mockUser,
      },
      mockStripe: {
        subscriptions: {
          retrieve: vi.fn(),
          update: vi.fn(),
          create: vi.fn(),
          del: vi.fn(),
          deleteDiscount: vi.fn(),
        },
        coupons: {
          create: vi.fn(),
          retrieve: vi.fn(),
          del: vi.fn(),
        },
        checkout: {
          sessions: {
            create: vi.fn(),
          },
        },
        billingPortal: {
          sessions: {
            create: vi.fn(),
          },
        },
        paymentMethods: {
          list: vi.fn(),
        },
      },
      mockCreateCustomer: vi.fn().mockResolvedValue('cus_recipient'),
      mockGetPlans: vi.fn(),
      mockCreateNotification: vi.fn().mockResolvedValue(undefined),
    };
  });

vi.mock('~/server/db/client', () => ({
  dbWrite: mockDbWrite,
  dbRead: mockDbWrite,
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: vi.fn().mockResolvedValue(mockStripe),
}));

vi.mock('~/server/services/stripe.service', () => ({
  createCustomer: mockCreateCustomer,
}));

vi.mock('~/server/services/subscriptions.service', () => ({
  getPlans: mockGetPlans,
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/utils/url-helpers', () => ({
  getBaseUrl: () => 'https://civitai.com',
}));

vi.mock('~/server/utils/errorHandling', () => ({
  throwBadRequestError: (message: string) => {
    throw new Error(message);
  },
  throwNotFoundError: (message: string) => {
    throw new Error(message);
  },
}));

import {
  createMembershipGiftCheckout,
  fulfillMembershipGift,
  getRecipientGiftability,
  keepGiftMembership,
  revokeMembershipGift,
} from '~/server/services/membership-gift.service';

const goldPlan = {
  id: 'prod_gold',
  price: { id: 'price_gold_month', unitAmount: 1000, currency: 'usd', interval: 'month' },
  metadata: { tier: 'gold' },
};

const baseGift = {
  id: 'gift_1',
  gifterId: 1,
  recipientId: 2,
  tier: 'gold',
  months: 3,
  amountCents: 3000,
  status: 'Pending',
  message: null,
  anonymous: false,
  stripeCheckoutSessionId: 'cs_1',
  stripePaymentIntentId: 'pi_1',
  stripeCouponId: null,
  stripeSubscriptionId: null,
  gifter: { id: 1, username: 'gifter' },
  recipient: { id: 2, username: 'recipient', email: 'r@x.com' },
};

const activeMonthlySub = {
  id: 'sub_1',
  status: 'active',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  currentPeriodEnd: dayjs().add(10, 'day').toDate(),
  product: { id: 'prod_gold', provider: 'Stripe', metadata: { tier: 'gold' } },
  price: { id: 'price_gold_month', interval: 'month' },
};

const stripeActiveSub = ({
  cancelAtPeriodEnd = false,
  cancelAt = null as number | null,
  interval = 'month',
  discount = null as any,
} = {}) => ({
  id: 'sub_1',
  status: 'active',
  cancel_at_period_end: cancelAtPeriodEnd,
  cancel_at: cancelAt,
  current_period_end: dayjs().add(10, 'day').unix(),
  discount,
  metadata: {},
  items: { data: [{ price: { recurring: { interval } } }] },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPlans.mockResolvedValue([goldPlan]);
  mockStripe.coupons.create.mockResolvedValue({ id: 'coupon_1' });
  mockStripe.coupons.retrieve.mockResolvedValue({ id: 'coupon_1' });
  mockStripe.coupons.del.mockResolvedValue({});
  mockStripe.subscriptions.update.mockResolvedValue({});
  mockStripe.subscriptions.del.mockResolvedValue({});
  mockStripe.subscriptions.deleteDiscount.mockResolvedValue({});
  mockDbWrite.membershipGift.update.mockResolvedValue({});
  mockDbWrite.membershipGift.delete.mockResolvedValue({});
  mockCreateCustomer.mockResolvedValue('cus_recipient');
  mockStripe.paymentMethods.list.mockResolvedValue({ data: [] });
  mockStripe.billingPortal.sessions.create.mockResolvedValue({ url: 'https://portal.stripe/x' });
});

describe('getRecipientGiftability', () => {
  it('returns no-subscription when there is no green row', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);
    expect(await getRecipientGiftability({ recipientUserId: 2 })).toEqual({
      status: 'no-subscription',
    });
  });

  it('returns no-subscription for terminal statuses', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...activeMonthlySub,
      status: 'canceled',
    });
    expect(await getRecipientGiftability({ recipientUserId: 2 })).toEqual({
      status: 'no-subscription',
    });
  });

  it('blocks annual subscriptions', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...activeMonthlySub,
      price: { id: 'price_gold_year', interval: 'year' },
    });
    expect(await getRecipientGiftability({ recipientUserId: 2 })).toMatchObject({
      status: 'blocked',
      reason: 'annual-interval',
    });
  });

  it('blocks billing-issue statuses', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...activeMonthlySub,
      status: 'past_due',
    });
    expect(await getRecipientGiftability({ recipientUserId: 2 })).toMatchObject({
      status: 'blocked',
      reason: 'billing-issue',
    });
  });

  it('blocks non-Stripe green subscriptions', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...activeMonthlySub,
      product: { ...activeMonthlySub.product, provider: 'Civitai' },
    });
    expect(await getRecipientGiftability({ recipientUserId: 2 })).toMatchObject({
      status: 'blocked',
      reason: 'unsupported-provider',
    });
  });

  it('returns active with tier for a monthly Stripe sub', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(activeMonthlySub);
    expect(await getRecipientGiftability({ recipientUserId: 2 })).toMatchObject({
      status: 'active',
      tier: 'gold',
    });
  });
});

describe('createMembershipGiftCheckout', () => {
  const input = {
    gifterId: 1,
    gifterEmail: 'g@x.com',
    recipientUserId: 2,
    tier: 'gold' as const,
    months: 3,
    anonymous: false,
  };

  beforeEach(() => {
    mockDbWrite.user.findUnique.mockResolvedValue({
      id: 2,
      username: 'recipient',
      bannedAt: null,
      deletedAt: null,
    });
    mockDbWrite.membershipGift.create.mockResolvedValue({ id: 'gift_1' });
    mockStripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_1',
      url: 'https://stripe/checkout',
    });
  });

  it('rejects tier mismatch against an active subscription', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...activeMonthlySub,
      product: { ...activeMonthlySub.product, metadata: { tier: 'bronze' } },
    });
    await expect(createMembershipGiftCheckout(input)).rejects.toThrow(/bronze membership/);
  });

  it('rejects annual recipients', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...activeMonthlySub,
      price: { id: 'price_gold_year', interval: 'year' },
    });
    await expect(createMembershipGiftCheckout(input)).rejects.toThrow(/annual membership/);
  });

  it('creates a pending gift and a payment-mode checkout session', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);

    const result = await createMembershipGiftCheckout(input);

    expect(mockDbWrite.membershipGift.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountCents: 3000, months: 3, tier: 'gold' }),
      })
    );
    const sessionArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(sessionArgs.mode).toBe('payment');
    expect(sessionArgs.line_items[0].quantity).toBe(3);
    expect(sessionArgs.metadata).toEqual({ type: 'membershipGift', giftId: 'gift_1' });
    expect(sessionArgs.payment_intent_data.metadata).toEqual({
      type: 'membershipGift',
      giftId: 'gift_1',
    });
    expect(result).toMatchObject({ giftId: 'gift_1', sessionId: 'cs_1' });
  });

  it('deletes the pending row when session creation fails', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);
    mockStripe.checkout.sessions.create.mockRejectedValue(new Error('stripe down'));

    await expect(createMembershipGiftCheckout(input)).rejects.toThrow('stripe down');
    expect(mockDbWrite.membershipGift.delete).toHaveBeenCalledWith({ where: { id: 'gift_1' } });
  });
});

describe('fulfillMembershipGift', () => {
  it('bails early when the gift was already fulfilled', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Fulfilled',
    });
    const result = await fulfillMembershipGift({ giftId: 'gift_1' });
    expect(result).toEqual({ alreadyProcessed: true });
    expect(mockStripe.coupons.create).not.toHaveBeenCalled();
  });

  it('extends an active monthly subscription with a 100%-off repeating coupon', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(activeMonthlySub);
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeActiveSub());

    const result = await fulfillMembershipGift({ giftId: 'gift_1', paymentIntentId: 'pi_1' });

    expect(mockStripe.coupons.create).toHaveBeenCalledWith(
      expect.objectContaining({
        percent_off: 100,
        duration: 'repeating',
        duration_in_months: 3,
        max_redemptions: 1,
      })
    );
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      coupon: 'coupon_1',
    });
    expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fulfilled: true, applied: 'extended' });
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'Fulfilled' }) })
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it('defers the cancellation instead of un-canceling a cancel_at_period_end sub', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(activeMonthlySub);
    const sub = stripeActiveSub({ cancelAtPeriodEnd: true });
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub);

    await fulfillMembershipGift({ giftId: 'gift_1' });

    const expectedCancelAt = dayjs.unix(sub.current_period_end).add(3, 'month').unix();
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      coupon: 'coupon_1',
      cancel_at: expectedCancelAt,
      cancel_at_period_end: false,
    });
  });

  it('pushes out an existing scheduled cancel_at by the gifted months', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(activeMonthlySub);
    const scheduled = dayjs().add(5, 'day').unix();
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeActiveSub({ cancelAt: scheduled }));

    await fulfillMembershipGift({ giftId: 'gift_1' });

    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      coupon: 'coupon_1',
      cancel_at: dayjs.unix(scheduled).add(3, 'month').unix(),
      cancel_at_period_end: false,
    });
  });

  it('marks the gift Failed when the recipient sub is not billed monthly', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(activeMonthlySub);
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeActiveSub({ interval: 'year' }));

    const result = await fulfillMembershipGift({ giftId: 'gift_1' });

    expect(result).toMatchObject({ fulfilled: false });
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'Failed' } })
    );
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('creates a gift subscription when the recipient has none', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);
    mockStripe.subscriptions.create.mockResolvedValue({ id: 'sub_new', status: 'active' });

    const result = await fulfillMembershipGift({ giftId: 'gift_1' });

    const createArgs = mockStripe.subscriptions.create.mock.calls[0][0];
    expect(createArgs.customer).toBe('cus_recipient');
    expect(createArgs.coupon).toBe('coupon_1');
    expect(createArgs.items).toEqual([{ price: 'price_gold_month' }]);
    expect(createArgs.payment_behavior).toBe('default_incomplete');
    expect(createArgs.metadata).toMatchObject({ membershipGiftId: 'gift_1' });
    // cancel_at ≈ now + 3 months
    expect(createArgs.cancel_at).toBeGreaterThan(dayjs().add(89, 'day').unix());
    expect(result).toMatchObject({ fulfilled: true, applied: 'created' });
  });

  it('falls back to creating a subscription when the Stripe sub is canceled despite a live DB row', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(activeMonthlySub);
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      ...stripeActiveSub(),
      status: 'canceled',
    });
    mockStripe.subscriptions.create.mockResolvedValue({ id: 'sub_new', status: 'active' });

    const result = await fulfillMembershipGift({ giftId: 'gift_1' });

    expect(mockStripe.subscriptions.create).toHaveBeenCalled();
    expect(result).toMatchObject({ fulfilled: true, applied: 'created' });
  });

  it('reuses a previously created subscription on retry', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      stripeSubscriptionId: 'sub_prev',
      stripeCouponId: 'coupon_1',
    });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_prev',
      status: 'active',
      metadata: { membershipGiftId: 'gift_1' },
    });

    const result = await fulfillMembershipGift({ giftId: 'gift_1' });

    expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fulfilled: true, stripeSubscriptionId: 'sub_prev' });
  });

  it('marks Failed for a non-Stripe green subscription', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...activeMonthlySub,
      product: { ...activeMonthlySub.product, provider: 'Civitai' },
    });

    const result = await fulfillMembershipGift({ giftId: 'gift_1' });

    expect(result).toMatchObject({ fulfilled: false });
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'Failed' } })
    );
  });
});

describe('revokeMembershipGift', () => {
  it('returns false when the payment intent is not a gift', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(null);
    expect(await revokeMembershipGift({ paymentIntentId: 'pi_x', reason: 'refund' })).toBe(false);
  });

  it('cancels a gift-created subscription and deletes the coupon', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      id: 'gift_1',
      status: 'Fulfilled',
      recipientId: 2,
      stripeCouponId: 'coupon_1',
      stripeSubscriptionId: 'sub_new',
    });
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_new',
      status: 'active',
      metadata: { membershipGiftId: 'gift_1' },
      discount: null,
    });

    const result = await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' });

    expect(result).toBe(true);
    expect(mockStripe.subscriptions.del).toHaveBeenCalledWith('sub_new');
    expect(mockStripe.coupons.del).toHaveBeenCalledWith('coupon_1');
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'Refunded' } })
    );
  });

  it('removes the discount from an extended subscription without canceling it', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      id: 'gift_1',
      status: 'Fulfilled',
      recipientId: 2,
      stripeCouponId: 'coupon_1',
      stripeSubscriptionId: 'sub_1',
    });
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      metadata: {},
      discount: { coupon: { id: 'coupon_1' } },
    });

    await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'chargeback' });

    expect(mockStripe.subscriptions.deleteDiscount).toHaveBeenCalledWith('sub_1');
    expect(mockStripe.subscriptions.del).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'Revoked' } })
    );
  });

  it('collapses a deferred cancellation back to period-end when revoking an extended sub', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      id: 'gift_1',
      status: 'Fulfilled',
      recipientId: 2,
      stripeCouponId: 'coupon_1',
      stripeSubscriptionId: 'sub_1',
    });
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      metadata: {},
      discount: { coupon: { id: 'coupon_1' } },
      cancel_at: dayjs().add(3, 'month').unix(),
    });

    await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' });

    expect(mockStripe.subscriptions.deleteDiscount).toHaveBeenCalledWith('sub_1');
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      cancel_at: '',
      cancel_at_period_end: true,
    });
  });

  it('is idempotent for already-revoked gifts', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      id: 'gift_1',
      status: 'Refunded',
      recipientId: 2,
      stripeCouponId: 'coupon_1',
      stripeSubscriptionId: 'sub_1',
    });

    expect(await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' })).toBe(true);
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });
});

describe('keepGiftMembership', () => {
  const cancelingStripeSub = ({
    customer = {
      id: 'cus_2',
      invoice_settings: { default_payment_method: null },
      default_source: null,
    } as any,
  } = {}) => ({
    ...stripeActiveSub({ cancelAt: dayjs().add(2, 'month').unix() }),
    customer,
  });

  beforeEach(() => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue({ ...activeMonthlySub });
  });

  it('clears the scheduled cancellation when a default payment method exists', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      cancelingStripeSub({
        customer: {
          id: 'cus_2',
          invoice_settings: { default_payment_method: 'pm_1' },
          default_source: null,
        },
      })
    );

    const result = await keepGiftMembership({ userId: 2 });

    expect(result).toEqual({ kept: true });
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      cancel_at: '',
      cancel_at_period_end: false,
    });
    expect(mockStripe.paymentMethods.list).not.toHaveBeenCalled();
  });

  it('accepts a legacy default_source without setting it as the subscription payment method', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      cancelingStripeSub({
        customer: { id: 'cus_2', invoice_settings: {}, default_source: 'card_legacy' },
      })
    );

    const result = await keepGiftMembership({ userId: 2 });

    expect(result).toEqual({ kept: true });
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      cancel_at: '',
      cancel_at_period_end: false,
    });
  });

  it('falls back to an attached card when no default payment method is set', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(cancelingStripeSub());
    mockStripe.paymentMethods.list.mockResolvedValue({ data: [{ id: 'pm_2' }] });

    const result = await keepGiftMembership({ userId: 2 });

    expect(result).toEqual({ kept: true });
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({ default_payment_method: 'pm_2' })
    );
  });

  it('returns a billing-portal URL when there is no payment method at all', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(cancelingStripeSub());

    const result = await keepGiftMembership({ userId: 2 });

    expect(result).toEqual({ kept: false, portalUrl: 'https://portal.stripe/x' });
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_2',
        flow_data: { type: 'payment_method_update' },
      })
    );
  });

  it('is a no-op when nothing is scheduled to cancel', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      ...stripeActiveSub(),
      customer: { id: 'cus_2', invoice_settings: {}, default_source: null },
    });

    const result = await keepGiftMembership({ userId: 2 });

    expect(result).toEqual({ kept: true });
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('throws when the user has no live green subscription', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);

    await expect(keepGiftMembership({ userId: 2 })).rejects.toThrow('No active membership');
  });
});
