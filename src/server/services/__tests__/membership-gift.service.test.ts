import { describe, it, expect, vi, beforeEach } from 'vitest';
import dayjs from 'dayjs';

const {
  mockDbWrite,
  mockStripe,
  mockCreateCustomer,
  mockGetPlans,
  mockCreateNotification,
  mockSendReceivedEmail,
  mockSendSentEmail,
} = vi.hoisted(() => {
  const mockMembershipGift = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
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
    mockSendReceivedEmail: vi.fn().mockResolvedValue(undefined),
    mockSendSentEmail: vi.fn().mockResolvedValue(undefined),
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

vi.mock('~/server/email/templates/membershipGiftReceived.email', () => ({
  membershipGiftReceivedEmail: { send: mockSendReceivedEmail },
}));

vi.mock('~/server/email/templates/membershipGiftSent.email', () => ({
  membershipGiftSentEmail: { send: mockSendSentEmail },
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
  acceptMembershipGift,
  armNextGiftMonth,
  createMembershipGiftCheckout,
  fulfillMembershipGift,
  getGiftOffer,
  getRecipientGiftability,
  honorGiftResidualsForUser,
  keepGiftMembership,
  recordGiftMonthConsumed,
  revokeMembershipGift,
  sweepGiftArming,
} from '~/server/services/membership-gift.service';

const plan = (tier: string, usd: number) => ({
  id: `prod_${tier}`,
  price: { id: `price_${tier}_usd`, unitAmount: usd, currency: 'usd', interval: 'month' },
  prices: [
    { id: `price_${tier}_usd`, unitAmount: usd, currency: 'usd', interval: 'month' },
    { id: `price_${tier}_eur`, unitAmount: usd, currency: 'eur', interval: 'month' },
    { id: `price_${tier}_jpy`, unitAmount: usd * 1.5, currency: 'jpy', interval: 'month' },
  ],
  metadata: { tier },
});

const PLANS = [plan('bronze', 1000), plan('silver', 2500), plan('gold', 5000)];

const baseGift = {
  id: 'gift_1',
  gifterId: 1,
  recipientId: 2,
  holderId: 2,
  tier: 'gold',
  months: 3,
  amountCents: 15000,
  status: 'Pending',
  message: null,
  anonymous: false,
  monthsRemaining: 0,
  monthsConsumed: 0,
  acceptedAt: null,
  expiresAt: null,
  armedCouponId: null,
  armedAt: null,
  stripeCheckoutSessionId: 'cs_1',
  stripePaymentIntentId: 'pi_1',
  stripeCouponId: null,
  stripeSubscriptionId: null,
  gifter: { id: 1, username: 'gifter', email: 'g@x.com' },
  recipient: { id: 2, username: 'recipient', email: 'r@x.com' },
  holder: { id: 2, email: 'r@x.com' },
};

const dbSub = ({
  tier = 'gold',
  status = 'active',
  currency = 'usd',
  interval = 'month',
  provider = 'Stripe',
} = {}) => ({
  id: 'sub_1',
  status,
  cancelAtPeriodEnd: false,
  cancelAt: null,
  currentPeriodEnd: dayjs().add(10, 'day').toDate(),
  product: { id: `prod_${tier}`, provider, metadata: { tier } },
  price: { id: `price_${tier}_${currency}`, interval, currency },
});

const stripeSub = ({ status = 'active', currency = 'usd', discount = null as any } = {}) => ({
  id: 'sub_1',
  status,
  currency,
  cancel_at_period_end: false,
  cancel_at: null,
  current_period_end: dayjs().add(10, 'day').unix(),
  discount,
  metadata: {},
  items: {
    data: [{ id: 'si_1', price: { id: 'price_gold_usd', recurring: { interval: 'month' } } }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPlans.mockResolvedValue(PLANS);
  mockStripe.coupons.create.mockImplementation(async (args: any) => ({ ...args }));
  // Every coupon id is derived from (gift, month), so "does this already exist" is asked on
  // every arm. Default to "no" — the tests that care about reuse override it.
  mockStripe.coupons.retrieve.mockRejectedValue(new Error('No such coupon'));
  mockStripe.coupons.del.mockResolvedValue({});
  mockStripe.subscriptions.update.mockResolvedValue({});
  mockStripe.subscriptions.del.mockResolvedValue({});
  mockStripe.subscriptions.create.mockResolvedValue({ id: 'sub_residual', status: 'active' });
  mockStripe.subscriptions.deleteDiscount.mockResolvedValue({});
  mockDbWrite.membershipGift.update.mockResolvedValue({});
  mockDbWrite.membershipGift.delete.mockResolvedValue({});
  mockDbWrite.membershipGift.findMany.mockResolvedValue([]);
  mockDbWrite.membershipGift.findFirst.mockResolvedValue(null);
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
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ status: 'canceled' }));
    expect(await getRecipientGiftability({ recipientUserId: 2 })).toEqual({
      status: 'no-subscription',
    });
  });

  it('blocks non-Stripe green subscriptions', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ provider: 'Civitai' }));
    expect(await getRecipientGiftability({ recipientUserId: 2 })).toMatchObject({
      status: 'blocked',
      reason: 'unsupported-provider',
    });
  });

  it('returns active with tier for a monthly Stripe sub', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
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

  it('allows gifting a tier the recipient does not have', async () => {
    // The whole point of the change: a bronze subscriber can be gifted gold.
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'bronze' }));

    const result = await createMembershipGiftCheckout(input);

    expect(result).toMatchObject({ giftId: 'gift_1' });
    expect(mockDbWrite.membershipGift.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tier: 'gold' }) })
    );
  });

  it('allows gifting an annual subscriber', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ interval: 'year' }));
    await expect(createMembershipGiftCheckout(input)).resolves.toMatchObject({ giftId: 'gift_1' });
  });

  it('still refuses a recipient whose membership is not managed by Stripe', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ provider: 'Civitai' }));
    await expect(createMembershipGiftCheckout(input)).rejects.toThrow(/cannot receive gifted/);
  });

  it('records the recipient as the initial holder', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);
    await createMembershipGiftCheckout(input);
    expect(mockDbWrite.membershipGift.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ holderId: 2, recipientId: 2 }) })
    );
  });

  it('creates a pending gift and a payment-mode checkout session', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);

    const result = await createMembershipGiftCheckout(input);

    const sessionArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(sessionArgs.mode).toBe('payment');
    expect(sessionArgs.line_items[0].quantity).toBe(3);
    expect(sessionArgs.metadata).toEqual({ type: 'membershipGift', giftId: 'gift_1' });
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
    expect(await fulfillMembershipGift({ giftId: 'gift_1' })).toEqual({ alreadyProcessed: true });
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });

  it('queues the gift with its full months and touches NOTHING in Stripe', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(baseGift);

    const result = await fulfillMembershipGift({ giftId: 'gift_1', paymentIntentId: 'pi_1' });

    expect(result).toMatchObject({ fulfilled: true, queued: true });
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'Fulfilled', monthsRemaining: 3 }),
      })
    );
    // Fulfilment used to apply a coupon or create a subscription. Acceptance is the
    // recipient's action now, so payment must move nothing.
    expect(mockStripe.coupons.create).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it('notifies the holder rather than the original recipient', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift, holderId: 7 });
    await fulfillMembershipGift({ giftId: 'gift_1' });
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'membership-gift-received', userId: 7 })
    );
  });

  it('emails both parties', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(baseGift);
    await fulfillMembershipGift({ giftId: 'gift_1' });
    expect(mockSendReceivedEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'r@x.com' }));
    expect(mockSendSentEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'g@x.com' }));
  });

  it('still queues the gift when an email fails to send', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(baseGift);
    mockSendReceivedEmail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(fulfillMembershipGift({ giftId: 'gift_1' })).resolves.toMatchObject({
      fulfilled: true,
    });
  });
});

describe('getGiftOffer', () => {
  const queued = { ...baseGift, status: 'Fulfilled', monthsRemaining: 3 };

  it('offers a value discount when the holder is on a HIGHER tier than the gift', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, tier: 'bronze' });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));

    expect(await getGiftOffer({ giftId: 'gift_1', userId: 2 })).toEqual({
      kind: 'value-discount',
      tier: 'bronze',
      months: 3,
      amountPerMonth: 1000,
      currency: 'usd',
    });
  });

  it('values the discount in the holder BILLING currency, not the default one', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, tier: 'bronze' });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(
      dbSub({ tier: 'gold', currency: 'jpy' })
    );

    expect(await getGiftOffer({ giftId: 'gift_1', userId: 2 })).toMatchObject({
      amountPerMonth: 1500,
      currency: 'jpy',
    });
  });

  it('offers a switch UP when the gift is a higher tier than the holder has', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, tier: 'gold' });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'bronze' }));

    expect(await getGiftOffer({ giftId: 'gift_1', userId: 2 })).toMatchObject({
      kind: 'switch-and-free-months',
      tier: 'gold',
      fromTier: 'bronze',
    });
  });

  it('offers free months when the tiers match', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, tier: 'gold' });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));

    expect(await getGiftOffer({ giftId: 'gift_1', userId: 2 })).toMatchObject({
      kind: 'free-months',
    });
  });

  it('offers a free subscription when the holder has none', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(queued);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);

    expect(await getGiftOffer({ giftId: 'gift_1', userId: 2 })).toMatchObject({
      kind: 'free-subscription',
      months: 3,
    });
  });

  it('refuses to describe a gift the caller does not hold', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, holderId: 99 });
    await expect(getGiftOffer({ giftId: 'gift_1', userId: 2 })).rejects.toThrow(/not found/i);
  });
});

describe('acceptMembershipGift', () => {
  const queued = { ...baseGift, status: 'Fulfilled', monthsRemaining: 3 };

  it('moves the holder UP to the gifted tier without raising an invoice', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, tier: 'gold' });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'bronze' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub());

    await acceptMembershipGift({ giftId: 'gift_1', userId: 2 });

    const [, args] = mockStripe.subscriptions.update.mock.calls[0];
    expect(args.items[0].price).toBe('price_gold_usd');
    // Anything other than 'none' bills them on the spot for a tier change they were given.
    expect(args.proration_behavior).toBe('none');
  });

  it('does NOT move a holder who is already on a higher tier', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, tier: 'bronze' });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub());

    await acceptMembershipGift({ giftId: 'gift_1', userId: 2 });

    const itemChanges = mockStripe.subscriptions.update.mock.calls.filter(([, a]: any) => a.items);
    expect(itemChanges).toHaveLength(0);
  });

  it('marks the gift Active with its months intact', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(queued);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub());

    await acceptMembershipGift({ giftId: 'gift_1', userId: 2 });

    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'Active', monthsRemaining: 3 }),
      })
    );
  });

  it('refuses a gift the caller does not hold', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, holderId: 99 });
    await expect(acceptMembershipGift({ giftId: 'gift_1', userId: 2 })).rejects.toThrow(
      /not found/i
    );
  });

  it('refuses an expired gift', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...queued,
      expiresAt: dayjs().subtract(1, 'day').toDate(),
    });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub());
    await expect(acceptMembershipGift({ giftId: 'gift_1', userId: 2 })).rejects.toThrow(/expired/i);
  });
});

describe('armNextGiftMonth', () => {
  const active = { ...baseGift, status: 'Active', monthsRemaining: 3, acceptedAt: new Date() };

  it('arms ONE month at a time — a once coupon, never a repeating one', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ ...active, tier: 'gold' }]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub());

    await armNextGiftMonth({ userId: 2 });

    const coupon = mockStripe.coupons.create.mock.calls[0][0];
    expect(coupon.duration).toBe('once');
    expect(coupon.duration_in_months).toBeUndefined();
    expect(coupon.percent_off).toBe(100);
  });

  it('arms the gift value as amount_off in the SUBSCRIPTION currency', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ ...active, tier: 'bronze' }]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(
      dbSub({ tier: 'gold', currency: 'jpy' })
    );
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ currency: 'jpy' }));

    await armNextGiftMonth({ userId: 2 });

    const coupon = mockStripe.coupons.create.mock.calls[0][0];
    expect(coupon.currency).toBe('jpy');
    expect(coupon.amount_off).toBe(1500);
    // A USD-only amount simply does not apply to a JPY invoice — Stripe accepts the coupon
    // and discounts nothing.
    expect(coupon.currency_options).toMatchObject({ usd: { amount_off: 1000 } });
  });

  it('refuses to arm when the subscription already carries someone else’s discount', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([active]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      stripeSub({ discount: { coupon: { id: 'promo_from_marketing' } } })
    );

    const result = await armNextGiftMonth({ userId: 2 });

    // Stripe REPLACES a discount silently when a second coupon is applied, with no error.
    expect(result).toMatchObject({ armed: false, reason: 'slot-occupied' });
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('does not arm a second month while one is already armed', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([
      { ...active, armedCouponId: 'gift_gift_1_m1' },
    ]);

    const result = await armNextGiftMonth({ userId: 2 });

    expect(result).toMatchObject({ armed: false, reason: 'already-armed' });
    expect(mockStripe.coupons.create).not.toHaveBeenCalled();
  });

  it('re-uses the coupon for the same month instead of minting a second one', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([active]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    mockStripe.coupons.retrieve.mockResolvedValue({ id: 'gift_gift_1_m1' });

    await armNextGiftMonth({ userId: 2 });

    expect(mockStripe.coupons.create).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      coupon: 'gift_gift_1_m1',
    });
  });

  it('names the coupon after the month it pays for, so a retry is idempotent', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ ...active, monthsConsumed: 1 }]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub());

    await armNextGiftMonth({ userId: 2 });

    expect(mockStripe.coupons.create.mock.calls[0][0].id).toBe('gift_gift_1_m2');
  });
});

describe('recordGiftMonthConsumed', () => {
  const armed = {
    ...baseGift,
    status: 'Active',
    monthsRemaining: 3,
    monthsConsumed: 0,
    armedCouponId: 'gift_gift_1_m1',
  };
  const invoice = (couponId: string | null) =>
    ({
      id: 'in_1',
      discount: couponId ? { coupon: { id: couponId } } : null,
    } as any);

  it('counts a month only once an invoice has actually used it', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue(armed);

    const result = await recordGiftMonthConsumed({ invoice: invoice('gift_gift_1_m1') });

    expect(result).toMatchObject({ consumed: true, monthsRemaining: 2 });
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthsRemaining: 2,
          monthsConsumed: 1,
          armedCouponId: null,
        }),
      })
    );
  });

  it('completes the gift when the last month is used', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue({
      ...armed,
      monthsRemaining: 1,
      monthsConsumed: 2,
    });

    await recordGiftMonthConsumed({ invoice: invoice('gift_gift_1_m3') });

    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ monthsRemaining: 0, status: 'Completed' }),
      })
    );
  });

  it('ignores an invoice carrying a coupon that is not a gift month', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue(null);
    expect(await recordGiftMonthConsumed({ invoice: invoice('promo_xyz') })).toEqual({
      consumed: false,
    });
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });

  it('ignores an invoice with no discount at all', async () => {
    expect(await recordGiftMonthConsumed({ invoice: invoice(null) })).toEqual({ consumed: false });
    expect(mockDbWrite.membershipGift.findFirst).not.toHaveBeenCalled();
  });

  it('is a no-op on webhook redelivery, because the armed coupon is cleared', async () => {
    // The second delivery finds nothing: armedCouponId no longer matches any Active gift.
    mockDbWrite.membershipGift.findFirst.mockResolvedValueOnce(armed).mockResolvedValueOnce(null);

    await recordGiftMonthConsumed({ invoice: invoice('gift_gift_1_m1') });
    mockDbWrite.membershipGift.update.mockClear();
    const second = await recordGiftMonthConsumed({ invoice: invoice('gift_gift_1_m1') });

    expect(second).toEqual({ consumed: false });
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });
});

describe('honorGiftResidualsForUser', () => {
  const halfUsed = {
    ...baseGift,
    status: 'Active',
    tier: 'bronze',
    months: 3,
    monthsRemaining: 2,
    monthsConsumed: 1,
  };

  it('hands over the months still owed as a free subscription when the holder cancels', async () => {
    // The regression this whole model exists for: cancelling mid-gift used to destroy the
    // unused months along with the subscription they were riding on.
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ id: 'gift_1' }]);
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(halfUsed);

    await honorGiftResidualsForUser({ userId: 2 });

    const args = mockStripe.subscriptions.create.mock.calls[0][0];
    expect(args.items[0].price).toBe('price_bronze_usd');
    expect(args.metadata.membershipGiftId).toBe('gift_1');
    const coupon = mockStripe.coupons.create.mock.calls[0][0];
    expect(coupon.percent_off).toBe(100);
    expect(coupon.duration_in_months).toBe(2);
  });

  it('ends the subscription when the owed months run out', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ id: 'gift_1' }]);
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(halfUsed);

    await honorGiftResidualsForUser({ userId: 2 });

    const args = mockStripe.subscriptions.create.mock.calls[0][0];
    // Whole-month diffs truncate on sub-second drift, so compare against the date itself:
    // covering `months` instead of `monthsRemaining` would land a month out, not hours.
    const driftHours = Math.abs(dayjs.unix(args.cancel_at).diff(dayjs().add(2, 'month'), 'hour'));
    expect(driftHours).toBeLessThan(24);
  });

  it('does nothing when no months are owed', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([]);
    expect(await honorGiftResidualsForUser({ userId: 2 })).toEqual({ minted: 0 });
    expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
  });
});

describe('sweepGiftArming', () => {
  it('only looks at holders with months owed and nothing armed', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([]);
    await sweepGiftArming();
    expect(mockDbWrite.membershipGift.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'Active',
          monthsRemaining: { gt: 0 },
          armedCouponId: null,
        }),
      })
    );
  });

  it('keeps going when one holder fails to arm', async () => {
    mockDbWrite.membershipGift.findMany
      .mockResolvedValueOnce([{ holderId: 2 }, { holderId: 3 }])
      .mockRejectedValueOnce(new Error('db blew up'))
      .mockResolvedValue([]);

    await expect(sweepGiftArming()).resolves.toMatchObject({ candidates: 2 });
  });
});

describe('revokeMembershipGift', () => {
  it('returns false when the payment intent is not a gift', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(null);
    expect(await revokeMembershipGift({ paymentIntentId: 'pi_x', reason: 'refund' })).toBe(false);
  });

  it('voids an unaccepted gift without touching Stripe', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Fulfilled',
      monthsRemaining: 3,
    });

    await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' });

    expect(mockStripe.subscriptions.del).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.deleteDiscount).not.toHaveBeenCalled();
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'Refunded', monthsRemaining: 0 }),
      })
    );
  });

  it('strips an armed month from the holder subscription', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Active',
      monthsRemaining: 2,
      armedCouponId: 'gift_gift_1_m2',
    });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      stripeSub({ discount: { coupon: { id: 'gift_gift_1_m2' } } })
    );

    await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'chargeback' });

    expect(mockStripe.subscriptions.deleteDiscount).toHaveBeenCalledWith('sub_1');
    expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'Revoked' }) })
    );
  });

  it('leaves an unrelated discount alone', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Active',
      armedCouponId: 'gift_gift_1_m2',
    });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      stripeSub({ discount: { coupon: { id: 'someone_elses_promo' } } })
    );

    await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' });

    expect(mockStripe.subscriptions.deleteDiscount).not.toHaveBeenCalled();
  });

  it('deletes a residual subscription that exists only because of this gift', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Completed',
      stripeSubscriptionId: 'sub_residual',
    });
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      ...stripeSub(),
      id: 'sub_residual',
      metadata: { membershipGiftId: 'gift_1' },
    });

    await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' });

    expect(mockStripe.subscriptions.del).toHaveBeenCalledWith('sub_residual');
  });

  it('is idempotent once revoked', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift, status: 'Revoked' });
    expect(await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' })).toBe(true);
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });
});

describe('keepGiftMembership', () => {
  it('clears a scheduled cancellation when a payment method exists', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub());
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      ...stripeSub(),
      cancel_at: dayjs().add(30, 'day').unix(),
      customer: { id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } },
    });

    expect(await keepGiftMembership({ userId: 2 })).toEqual({ kept: true });
    const [, args] = mockStripe.subscriptions.update.mock.calls[0];
    expect(args.cancel_at).toBe('');
    expect(args.cancel_at_period_end).toBe(false);
  });

  it('returns a billing-portal url when there is no way to pay', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub());
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      ...stripeSub(),
      cancel_at: dayjs().add(30, 'day').unix(),
      customer: { id: 'cus_1', invoice_settings: {} },
    });

    const result = await keepGiftMembership({ userId: 2 });
    expect(result).toMatchObject({ kept: false, portalUrl: 'https://portal.stripe/x' });
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });
});
