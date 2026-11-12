import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dayjs from 'dayjs';
import type { Stripe } from 'stripe';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Every asserted call in this file is one `membership-gift.service` spells as `dbWrite`.
const mockDbWrite = dbMock.dbWrite;

const {
  mockStripe,
  mockCreateCustomer,
  mockGetPlans,
  mockCreateNotification,
  mockSendReceivedEmail,
  mockSendSentEmail,
} = vi.hoisted(() => {
  return {
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
  getMyMembershipGifts,
  getRecipientGiftability,
  holdsOpenMembershipGift,
  honorGiftResidualsForUser,
  keepGiftMembership,
  recordGiftMonthConsumed,
  releaseArmedGiftMonth,
  restoreArmedGiftMonth,
  restoreUndeliveredResidualMonths,
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

const stripeSub = ({
  status = 'active',
  currency = 'usd',
  discount = null as any,
  interval = 'month',
  unitAmount = 5000,
  tier = 'gold',
} = {}) => ({
  id: 'sub_1',
  status,
  currency,
  cancel_at_period_end: false,
  cancel_at: null,
  current_period_end: dayjs().add(10, 'day').unix(),
  discount,
  metadata: {},
  items: {
    data: [
      {
        id: 'si_1',
        price: {
          id: `price_${tier}_${currency}`,
          product: `prod_${tier}`,
          unit_amount: unitAmount,
          recurring: { interval },
        },
      },
    ],
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
  mockDbWrite.membershipGift.updateMany.mockResolvedValue({ count: 1 });
  mockDbWrite.membershipGift.delete.mockResolvedValue({});
  mockDbWrite.membershipGift.updateMany.mockResolvedValue({ count: 1 });
  mockDbWrite.membershipGift.findMany.mockResolvedValue([]);
  mockDbWrite.membershipGift.findFirst.mockResolvedValue(null);
  mockCreateCustomer.mockResolvedValue('cus_recipient');
  mockDbWrite.product.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: string };
  }) => ({
    id: where.id,
    metadata: { tier: where.id.replace('prod_', '') },
  })) as never);
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

  // Deliberate: do not widen to dynamic payment methods. The paid gate cannot see a debit
  // reversed after it succeeded.
  it('offers only card payment for a gift', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(null);

    await createMembershipGiftCheckout(input);

    const sessionArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(sessionArgs.payment_method_types).toEqual(['card']);
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
    expect(mockDbWrite.membershipGift.updateMany).not.toHaveBeenCalled();
  });

  it('sends nothing when a concurrent delivery fulfilled the gift first', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(baseGift);
    mockDbWrite.membershipGift.updateMany.mockResolvedValue({ count: 0 });

    expect(await fulfillMembershipGift({ giftId: 'gift_1' })).toEqual({ alreadyProcessed: true });
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendReceivedEmail).not.toHaveBeenCalled();
    expect(mockSendSentEmail).not.toHaveBeenCalled();
  });

  it('queues the gift with its full months and touches NOTHING in Stripe', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(baseGift);

    const result = await fulfillMembershipGift({ giftId: 'gift_1', paymentIntentId: 'pi_1' });

    expect(result).toMatchObject({ fulfilled: true, queued: true });
    expect(mockDbWrite.membershipGift.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'gift_1', status: 'Pending' },
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

  it('offers the whole cash value to a holder who is billed yearly, whatever the tiers', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, tier: 'gold' });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(
      dbSub({ tier: 'bronze', interval: 'year', currency: 'jpy' })
    );

    expect(await getGiftOffer({ giftId: 'gift_1', userId: 2 })).toEqual({
      kind: 'renewal-discount',
      tier: 'gold',
      months: 3,
      amount: 3 * 7500,
      currency: 'jpy',
    });
  });

  it('makes no offer on a gift that was applied in full when it was paid', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, monthsRemaining: 0 });
    await expect(getGiftOffer({ giftId: 'gift_1', userId: 2 })).rejects.toThrow(
      /already been used/i
    );
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

  it('does NOT move a holder who is billed yearly, even up to a higher tier', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, tier: 'gold' });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(
      dbSub({ tier: 'bronze', interval: 'year' })
    );
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ interval: 'year' }));

    await acceptMembershipGift({ giftId: 'gift_1', userId: 2 });

    const itemChanges = mockStripe.subscriptions.update.mock.calls.filter(([, a]: any) => a.items);
    expect(itemChanges).toHaveLength(0);
  });

  it('marks the gift Active with its months intact', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(queued);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub());

    await acceptMembershipGift({ giftId: 'gift_1', userId: 2 });

    const [{ data }] = mockDbWrite.membershipGift.update.mock.calls[0];
    expect(data).toMatchObject({ status: 'Active' });
    expect(data).not.toHaveProperty('monthsRemaining');
  });

  it('refuses a gift that was applied in full when it was paid', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...queued, monthsRemaining: 0 });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));

    await expect(acceptMembershipGift({ giftId: 'gift_1', userId: 2 })).rejects.toThrow(
      /not available to accept/i
    );
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    expect(mockStripe.coupons.create).not.toHaveBeenCalled();
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

describe('getMyMembershipGifts', () => {
  const receivedRow = {
    id: 'gift_1',
    tier: 'gold',
    months: 3,
    message: null,
    anonymous: false,
    monthsConsumed: 0,
    acceptedAt: null,
    expiresAt: null,
    fulfilledAt: new Date(),
    gifter: { id: 1, username: 'gifter' },
  };

  it('lists a gift as waiting only while it has months left to accept', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { ...receivedRow, id: 'queued', status: 'Fulfilled', monthsRemaining: 3 },
      { ...receivedRow, id: 'applied_at_payment', status: 'Fulfilled', monthsRemaining: 0 },
      { ...receivedRow, id: 'in_use', status: 'Active', monthsRemaining: 2 },
    ]);

    const { received } = await getMyMembershipGifts({ userId: 2 });

    expect(received.map((gift) => [gift.id, gift.pending])).toEqual([
      ['queued', true],
      ['applied_at_payment', false],
      ['in_use', false],
    ]);
  });
});

describe('holdsOpenMembershipGift', () => {
  it('asks for a gift the user holds that still has months to give', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue({ id: 'gift_1' });

    expect(await holdsOpenMembershipGift({ userId: 2 })).toBe(true);
    expect(mockDbWrite.membershipGift.findFirst.mock.calls[0][0].where).toEqual({
      holderId: 2,
      status: { in: ['Fulfilled', 'Active'] },
      monthsRemaining: { gt: 0 },
    });
  });

  it('is false when there is none', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue(null);
    expect(await holdsOpenMembershipGift({ userId: 2 })).toBe(false);
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

  it('waits while an upgrade is held, so the month is not priced for the plan being left', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([active]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      ...stripeSub(),
      pending_update: { expires_at: 1 },
    });

    const result = await armNextGiftMonth({ userId: 2 });

    expect(result).toMatchObject({ armed: false, reason: 'plan-change-pending' });
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
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

// Webhooks write our CustomerSubscription row in no guaranteed order, so after a plan change it can
// still name the old plan. The subscription retrieved from Stripe is the plan the gift will be billed on.
describe('armNextGiftMonth prices against the live Stripe plan, not our row', () => {
  const active = { ...baseGift, status: 'Active', monthsRemaining: 3, acceptedAt: new Date() };

  it('a holder our row still calls bronze, now gold in Stripe, gets a silver gift as cash value', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ ...active, tier: 'silver' }]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'bronze' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ tier: 'gold' }));

    await armNextGiftMonth({ userId: 2 });

    const coupon = mockStripe.coupons.create.mock.calls[0][0];
    expect(coupon.percent_off).toBeUndefined();
    expect(coupon).toMatchObject({ amount_off: 2500, currency: 'usd' });
  });

  it('a holder our row still calls monthly, now yearly in Stripe, gets cash value', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ ...active, tier: 'gold' }]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(
      dbSub({ tier: 'gold', interval: 'month' })
    );
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      stripeSub({ tier: 'gold', interval: 'year', unitAmount: 50000 })
    );

    await armNextGiftMonth({ userId: 2 });

    const coupon = mockStripe.coupons.create.mock.calls[0][0];
    expect(coupon.percent_off).toBeUndefined();
    expect(coupon).toMatchObject({ amount_off: 3 * 5000, currency: 'usd' });
  });

  it('does not arm when the live price names a product we have no row for', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([active]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ tier: 'gold' }));
    mockDbWrite.product.findUnique.mockResolvedValue(null);

    const result = await armNextGiftMonth({ userId: 2 });

    expect(result).toMatchObject({ armed: false, reason: 'unknown-product' });
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('armNextGiftMonth on a subscription billed yearly', () => {
  const active = { ...baseGift, status: 'Active', monthsRemaining: 3, acceptedAt: new Date() };
  const armYearly = async ({ giftTier = 'gold', holderTier = 'gold', unitAmount = 50000 } = {}) => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ ...active, tier: giftTier }]);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(
      dbSub({ tier: holderTier, interval: 'year' })
    );
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      stripeSub({ interval: 'year', unitAmount, tier: holderTier })
    );
    await armNextGiftMonth({ userId: 2 });
    return mockStripe.coupons.create.mock.calls[0][0];
  };

  it('never arms 100% off — that would zero a whole year for one gifted month', async () => {
    const coupon = await armYearly({ giftTier: 'gold', holderTier: 'gold' });

    expect(coupon.percent_off).toBeUndefined();
    expect(coupon.duration).toBe('once');
  });

  it('arms the cash value of every month the renewal can absorb, in one coupon', async () => {
    const coupon = await armYearly({ giftTier: 'gold', holderTier: 'bronze', unitAmount: 50000 });

    expect(coupon).toMatchObject({ amount_off: 3 * 5000, currency: 'usd' });
    expect(coupon.currency_options.jpy).toEqual({ amount_off: 3 * 7500 });
    expect(coupon.metadata).toMatchObject({ months: '3' });
    expect(coupon.id).toBe('gift_gift_1_m1_x3');
  });

  it('leaves on the gift the months a smaller renewal cannot absorb', async () => {
    // 12000 holds two 5000 months; a third would be capped at the invoice total and lost.
    const coupon = await armYearly({ giftTier: 'gold', holderTier: 'bronze', unitAmount: 12000 });

    expect(coupon.amount_off).toBe(2 * 5000);
    expect(coupon.metadata).toMatchObject({ months: '2' });
    expect(coupon.id).toBe('gift_gift_1_m1_x2');
  });

  it('still arms one month when a single month is worth more than the renewal', async () => {
    const coupon = await armYearly({ giftTier: 'gold', holderTier: 'bronze', unitAmount: 3000 });

    expect(coupon.amount_off).toBe(5000);
    expect(coupon.metadata).toMatchObject({ months: '1' });
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
    expect(mockDbWrite.membershipGift.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthsRemaining: 2,
          monthsConsumed: 1,
          armedCouponId: null,
        }),
      })
    );
  });

  it('counts every month a yearly renewal absorbed, and keeps the rest', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue({
      ...armed,
      armedCouponId: 'gift_gift_1_m1_x2',
    });

    const result = await recordGiftMonthConsumed({
      invoice: {
        id: 'in_1',
        discount: { coupon: { id: 'gift_gift_1_m1_x2', metadata: { months: '2' } } },
      } as any,
    });

    expect(result).toMatchObject({ consumed: true, monthsRemaining: 1 });
    expect(mockDbWrite.membershipGift.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ monthsRemaining: 1, monthsConsumed: 2 }),
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

    expect(mockDbWrite.membershipGift.updateMany).toHaveBeenCalledWith(
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
    expect(mockDbWrite.membershipGift.updateMany).not.toHaveBeenCalled();
  });

  it('ignores an invoice with no discount at all', async () => {
    expect(await recordGiftMonthConsumed({ invoice: invoice(null) })).toEqual({ consumed: false });
    expect(mockDbWrite.membershipGift.findFirst).not.toHaveBeenCalled();
  });

  it('is a no-op on webhook redelivery, because the armed coupon is cleared', async () => {
    // The second delivery finds nothing: armedCouponId no longer matches any Active gift.
    mockDbWrite.membershipGift.findFirst.mockResolvedValueOnce(armed).mockResolvedValueOnce(null);

    await recordGiftMonthConsumed({ invoice: invoice('gift_gift_1_m1') });
    mockDbWrite.membershipGift.updateMany.mockClear();
    const second = await recordGiftMonthConsumed({ invoice: invoice('gift_gift_1_m1') });

    expect(second).toEqual({ consumed: false });
    expect(mockDbWrite.membershipGift.updateMany).not.toHaveBeenCalled();
  });

  it('a stale concurrent delivery cannot clear the month the first one armed', async () => {
    // Two deliveries of one invoice both read the row armed with m1. A consumes it and arms m2;
    // if B's write from its stale read then lands, the row forgets m2 while Stripe still carries
    // it, and the invoice that uses m2 is never counted: an extra free month.
    let row: Record<string, unknown> = { ...armed, acceptedAt: new Date() };
    let stripeDiscount: { coupon: { id: string } } | null = null;
    const matches = (where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => row[k] === v);
    let armWritten!: () => void;
    const armed2 = new Promise<void>((resolve) => (armWritten = resolve));
    let consumeWrites = 0;
    const write = async ({ where, data }: { where: Record<string, unknown>; data: any }) => {
      if ('monthsConsumed' in data && ++consumeWrites === 2) await armed2;
      if (!matches(where)) return 0;
      row = { ...row, ...data };
      if (data.armedCouponId) armWritten();
      return 1;
    };
    mockDbWrite.membershipGift.findFirst.mockImplementation((async ({ where }: any) =>
      matches(where) ? { ...row } : null) as never);
    mockDbWrite.membershipGift.findMany.mockImplementation((async () =>
      row.status === 'Active' && (row.monthsRemaining as number) > 0 ? [{ ...row }] : []) as never);
    mockDbWrite.membershipGift.update.mockImplementation((async (args: any) => {
      await write(args);
      return { ...row };
    }) as never);
    mockDbWrite.membershipGift.updateMany.mockImplementation((async (args: any) => ({
      count: await write(args),
    })) as never);
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub());
    mockStripe.subscriptions.retrieve.mockImplementation(async () =>
      stripeSub({ discount: stripeDiscount })
    );
    mockStripe.subscriptions.update.mockImplementation(async (_id: string, args: any) => {
      if (args.coupon) stripeDiscount = { coupon: { id: args.coupon } };
      return {};
    });

    const results = await Promise.all([
      recordGiftMonthConsumed({ invoice: invoice('gift_gift_1_m1') }),
      recordGiftMonthConsumed({ invoice: invoice('gift_gift_1_m1') }),
    ]);

    expect(stripeDiscount).toEqual({ coupon: { id: 'gift_gift_1_m2' } });
    expect(row.armedCouponId).toBe('gift_gift_1_m2');
    expect(row).toMatchObject({ monthsRemaining: 2, monthsConsumed: 1 });
    expect(results.filter((r) => r.consumed)).toHaveLength(1);
  });
});

describe('releaseArmedGiftMonth', () => {
  it('detaches the armed month without counting it as used', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue({
      id: 'gift_1',
      armedCouponId: 'gift_gift_1_m1',
    });

    const released = await releaseArmedGiftMonth({ userId: 2 });

    expect(released).toEqual({ giftId: 'gift_1', couponId: 'gift_gift_1_m1' });
    const [{ data }] = mockDbWrite.membershipGift.update.mock.calls[0];
    expect(data).toEqual({ armedCouponId: null, armedAt: null });
    expect(mockStripe.coupons.del).toHaveBeenCalledWith('gift_gift_1_m1');
  });

  it('leaves the discount on the subscription for the plan change to clear', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue({
      id: 'gift_1',
      armedCouponId: 'gift_gift_1_m1',
    });

    await releaseArmedGiftMonth({ userId: 2 });

    expect(mockStripe.subscriptions.deleteDiscount).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('does nothing for a holder with no month armed', async () => {
    mockDbWrite.membershipGift.findFirst.mockResolvedValue(null);

    expect(await releaseArmedGiftMonth({ userId: 2 })).toBeNull();
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
    expect(mockStripe.coupons.del).not.toHaveBeenCalled();
  });

  it('can be undone when the plan change fails', async () => {
    await restoreArmedGiftMonth({ giftId: 'gift_1', couponId: 'gift_gift_1_m1' });

    const [{ where, data }] = mockDbWrite.membershipGift.update.mock.calls[0];
    expect(where).toEqual({ id: 'gift_1' });
    expect(data).toMatchObject({ armedCouponId: 'gift_gift_1_m1' });
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

  describe('ends on a period boundary of the subscription Stripe created', () => {
    // Stripe stamps the subscription a moment after we ask for it. An end date read off our
    // clock lands just short of the boundary, and Stripe bills the first month as a proration
    // line, which grants no Membership bonus.
    const now = dayjs.utc('2026-01-31T12:00:00Z');
    const anchor = now.add(1, 'second');

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now.toDate());
      mockDbWrite.membershipGift.findMany.mockResolvedValue([{ id: 'gift_1' }]);
      mockStripe.subscriptions.create.mockResolvedValue({
        id: 'sub_residual',
        status: 'active',
        billing_cycle_anchor: anchor.unix(),
        current_period_start: anchor.unix(),
        current_period_end: anchor.add(1, 'month').unix(),
      });
    });
    afterEach(() => vi.useRealTimers());

    // Any end date sent with the create is read off our clock, which is the bug.
    const effectiveCancelAt = () => {
      const created = mockStripe.subscriptions.create.mock.calls[0][0];
      expect(created.cancel_at).toBeUndefined();
      const update = mockStripe.subscriptions.update.mock.calls.find(
        ([id, args]) => id === 'sub_residual' && 'cancel_at' in args
      );
      if (update) return update[1].cancel_at;
      return created.cancel_at_period_end ? anchor.add(1, 'month').unix() : null;
    };

    it('ends after exactly the months owed, counted from the anchor', async () => {
      mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...halfUsed, monthsRemaining: 3 });
      await honorGiftResidualsForUser({ userId: 2 });

      // Jan 31 + 3 months clamps to Apr 30, as Stripe's monthly cycle does.
      expect(effectiveCancelAt()).toBe(dayjs.utc('2026-04-30T12:00:01Z').unix());
      const update = mockStripe.subscriptions.update.mock.calls[0][1];
      // Stripe rejects the update if cancel_at_period_end rides along with cancel_at.
      expect(update).toEqual({ cancel_at: effectiveCancelAt(), proration_behavior: 'none' });
    });

    it('needs no second call for a single month', async () => {
      mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...halfUsed, monthsRemaining: 1 });
      await honorGiftResidualsForUser({ userId: 2 });

      expect(effectiveCancelAt()).toBe(anchor.add(1, 'month').unix());
      expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('still completes the gift when setting the end date fails, leaving a one-month subscription', async () => {
      mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...halfUsed, monthsRemaining: 3 });
      mockStripe.subscriptions.update.mockRejectedValue(new Error('Stripe is down'));

      await expect(honorGiftResidualsForUser({ userId: 2 })).resolves.toEqual({ minted: 1 });

      // The fallback: no end date of our own, and Stripe ends it after the first period.
      const created = mockStripe.subscriptions.create.mock.calls[0][0];
      expect(created.cancel_at).toBeUndefined();
      expect(created.cancel_at_period_end).toBe(true);
      expect(mockDbWrite.membershipGift.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'Completed',
            stripeSubscriptionId: 'sub_residual',
          }),
        })
      );
    });
  });

  it('re-mints the rest when a residual whose end date never got written ends after month one', async () => {
    // The fallback of a failed cancel_at write: Stripe ends the 3-month residual at its first
    // period end. Month one was delivered (and its invoice granted the bonus), so 2 come back
    // and a fresh residual covers them under a new coupon and idempotency key.
    const start = dayjs().subtract(1, 'month');
    const completed = {
      ...baseGift,
      status: 'Completed',
      monthsRemaining: 0,
      monthsConsumed: 3,
      stripeSubscriptionId: 'sub_residual',
      stripeCouponId: 'gift_gift_1_residual_m1',
    };
    mockDbWrite.membershipGift.findUnique.mockImplementation(async () =>
      mockDbWrite.membershipGift.updateMany.mock.calls.length
        ? { ...completed, status: 'Active', monthsRemaining: 2, monthsConsumed: 1 }
        : completed
    );
    mockDbWrite.membershipGift.findMany.mockImplementation(async () =>
      mockDbWrite.membershipGift.updateMany.mock.calls.length ? [{ id: 'gift_1' }] : []
    );

    await honorGiftResidualsForUser({
      userId: 2,
      endedSubscription: residualSub({ start, endedAt: start.add(1, 'month') }),
    });

    expect(mockDbWrite.membershipGift.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ monthsRemaining: 2 }) })
    );
    const [, options] = mockStripe.subscriptions.create.mock.calls[0];
    expect(options.idempotencyKey).toBe('gift_gift_1_residual_m2');
  });

  it('does nothing when no months are owed', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([]);
    expect(await honorGiftResidualsForUser({ userId: 2 })).toEqual({ minted: 0 });
    expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it('gives back the owed months when the holder cancels their residual subscription', async () => {
    // A 3-month residual cancelled in its first month: Stripe ends it at the period end, one
    // month in. The gift was completed at mint, so without a restore the 2 months are gone.
    const start = dayjs().subtract(1, 'month');
    const completed = {
      ...baseGift,
      status: 'Completed',
      monthsRemaining: 0,
      monthsConsumed: 3,
      stripeSubscriptionId: 'sub_residual',
      stripeCouponId: 'gift_gift_1_residual',
    };
    mockDbWrite.membershipGift.findUnique.mockImplementation(async () =>
      mockDbWrite.membershipGift.updateMany.mock.calls.length
        ? { ...completed, status: 'Active', monthsRemaining: 2, monthsConsumed: 1 }
        : completed
    );
    mockDbWrite.membershipGift.findMany.mockImplementation(async () =>
      mockDbWrite.membershipGift.updateMany.mock.calls.length ? [{ id: 'gift_1' }] : []
    );

    await honorGiftResidualsForUser({
      userId: 2,
      endedSubscription: residualSub({ start, endedAt: start.add(1, 'month') }),
    });

    expect(mockDbWrite.membershipGift.updateMany).toHaveBeenCalledWith({
      where: { id: 'gift_1', status: 'Completed', stripeSubscriptionId: 'sub_residual' },
      data: { status: 'Active', monthsRemaining: 2, monthsConsumed: 1 },
    });
    const coupon = mockStripe.coupons.create.mock.calls[0][0];
    expect(coupon.duration_in_months).toBe(2);
    // The first residual coupon is single-use and already redeemed.
    expect(coupon.id).not.toBe('gift_gift_1_residual');
    expect(mockStripe.subscriptions.create).toHaveBeenCalled();
  });
});

const residualSub = ({
  start,
  endedAt,
  metadata = { membershipGiftId: 'gift_1', residualMonths: '3' } as Record<string, string>,
  cancellationComment = null as string | null,
}: {
  start: dayjs.Dayjs;
  endedAt: dayjs.Dayjs;
  metadata?: Record<string, string>;
  cancellationComment?: string | null;
}) =>
  ({
    id: 'sub_residual',
    status: 'canceled',
    start_date: start.unix(),
    ended_at: endedAt.unix(),
    canceled_at: endedAt.unix(),
    cancellation_details: { comment: cancellationComment },
    discount: { coupon: { id: 'gift_gift_1_residual', duration_in_months: 3 } },
    metadata,
  } as unknown as Stripe.Subscription);

describe('restoreUndeliveredResidualMonths', () => {
  const start = dayjs().subtract(2, 'month');

  beforeEach(() => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Completed',
      monthsConsumed: 3,
      stripeSubscriptionId: 'sub_residual',
      stripeCouponId: 'gift_gift_1_residual',
    });
  });

  it('counts the first month as used even when cancelled minutes after the mint', async () => {
    // Its invoice already granted the month; giving it back would let cancel-and-re-mint
    // repeat forever.
    const result = await restoreUndeliveredResidualMonths({
      subscription: residualSub({ start, endedAt: start.add(4, 'minute') }),
    });
    expect(result).toMatchObject({ restored: 2 });
  });

  it('does not count the next period as started when the end lands just past a boundary', async () => {
    const result = await restoreUndeliveredResidualMonths({
      subscription: residualSub({ start, endedAt: start.add(1, 'month').add(30, 'second') }),
    });
    expect(result).toMatchObject({ restored: 2 });
  });

  it('counts a period cut short as used', async () => {
    const result = await restoreUndeliveredResidualMonths({
      subscription: residualSub({ start, endedAt: start.add(2, 'month').subtract(2, 'day') }),
    });
    expect(result).toMatchObject({ restored: 1 });
  });

  it('restores nothing when the subscription ran its full course', async () => {
    // It ends at the cancel_at set at mint, seconds before start + months.
    const result = await restoreUndeliveredResidualMonths({
      subscription: residualSub({ start, endedAt: start.add(3, 'month').subtract(5, 'second') }),
    });
    expect(result).toEqual({ restored: 0 });
    expect(mockDbWrite.membershipGift.updateMany).not.toHaveBeenCalled();
  });

  it('reads the months off the coupon for a residual minted before they were recorded', async () => {
    const result = await restoreUndeliveredResidualMonths({
      subscription: residualSub({
        start,
        endedAt: start.add(2, 'month'),
        metadata: { membershipGiftId: 'gift_1' },
      }),
    });
    expect(result).toMatchObject({ restored: 1 });
  });

  it('does not restore a residual ended by a refund or chargeback', async () => {
    const result = await restoreUndeliveredResidualMonths({
      subscription: residualSub({
        start,
        endedAt: start.add(1, 'day'),
        cancellationComment: 'membership-gift-revoked',
      }),
    });
    expect(result).toEqual({ restored: 0 });
    expect(mockDbWrite.membershipGift.updateMany).not.toHaveBeenCalled();
  });

  it('does not restore for a holder whose account was banned', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Completed',
      stripeSubscriptionId: 'sub_residual',
      holder: { id: 2, bannedAt: new Date(), deletedAt: null },
    });
    const result = await restoreUndeliveredResidualMonths({
      subscription: residualSub({ start, endedAt: start.add(1, 'month') }),
    });
    expect(result).toEqual({ restored: 0 });
    expect(mockDbWrite.membershipGift.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op once the gift has moved past that subscription', async () => {
    mockDbWrite.membershipGift.updateMany.mockResolvedValue({ count: 0 });
    const result = await restoreUndeliveredResidualMonths({
      subscription: residualSub({ start, endedAt: start.add(1, 'month') }),
    });
    expect(result).toEqual({ restored: 0 });
    expect(mockStripe.coupons.del).not.toHaveBeenCalled();
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

    expect(mockStripe.subscriptions.del).toHaveBeenCalledWith('sub_residual', {
      cancellation_details: { comment: 'membership-gift-revoked' },
    });
  });

  it('is idempotent once revoked', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({ ...baseGift, status: 'Revoked' });
    expect(await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' })).toBe(true);
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });
});

describe('keepGiftMembership', () => {
  const card = (id: string) => ({ id, object: 'payment_method', type: 'card' });
  const bankDebit = (id: string) => ({ id, object: 'payment_method', type: 'us_bank_account' });
  const cancellingSub = (fields: Record<string, unknown>) => ({
    ...stripeSub(),
    cancel_at: dayjs().add(30, 'day').unix(),
    default_payment_method: null,
    default_source: null,
    ...fields,
  });

  beforeEach(() => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub());
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe/setup' });
  });

  it('clears a scheduled cancellation and leaves a card default alone', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      cancellingSub({
        customer: { id: 'cus_1', invoice_settings: { default_payment_method: card('pm_card') } },
      })
    );

    expect(await keepGiftMembership({ userId: 2 })).toEqual({ kept: true });
    const [, args] = mockStripe.subscriptions.update.mock.calls[0];
    expect(args).toEqual({ cancel_at: '', cancel_at_period_end: false });
  });

  it('bills the customer default card when the subscription default is a bank debit', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      cancellingSub({
        default_payment_method: bankDebit('pm_ach'),
        customer: { id: 'cus_1', invoice_settings: { default_payment_method: card('pm_card') } },
      })
    );

    expect(await keepGiftMembership({ userId: 2 })).toEqual({ kept: true });
    const [, args] = mockStripe.subscriptions.update.mock.calls[0];
    expect(args.default_payment_method).toBe('pm_card');
    expect(args.cancel_at).toBe('');
  });

  it('bills a saved card when the customer default is a bank debit', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      cancellingSub({
        customer: {
          id: 'cus_1',
          invoice_settings: { default_payment_method: bankDebit('pm_ach') },
        },
      })
    );
    mockStripe.paymentMethods.list.mockResolvedValue({
      data: [
        { id: 'pm_expired_card', card: { exp_month: 1, exp_year: 2020 } },
        { id: 'pm_saved_card', card: { exp_month: 12, exp_year: dayjs().year() + 2 } },
      ],
    });

    expect(await keepGiftMembership({ userId: 2 })).toEqual({ kept: true });
    expect(mockStripe.paymentMethods.list.mock.calls[0][0]).toMatchObject({ type: 'card' });
    const [, args] = mockStripe.subscriptions.update.mock.calls[0];
    expect(args.default_payment_method).toBe('pm_saved_card');
  });

  it.each([
    ['subscription', { default_source: { id: 'card_1', object: 'card' } }],
    [
      'customer',
      {
        customer: {
          id: 'cus_1',
          invoice_settings: { default_payment_method: null },
          default_source: { id: 'src_1', object: 'source', type: 'card' },
        },
      },
    ],
  ])('keeps a legacy card source on the %s as it is', async (_, fields) => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      cancellingSub({
        customer: {
          id: 'cus_1',
          invoice_settings: { default_payment_method: bankDebit('pm_ach') },
        },
        ...fields,
      })
    );

    expect(await keepGiftMembership({ userId: 2 })).toEqual({ kept: true });
    const [, args] = mockStripe.subscriptions.update.mock.calls[0];
    expect(args).toEqual({ cancel_at: '', cancel_at_period_end: false });
  });

  it('keeps the cancellation and offers a card-only setup when only a bank debit is on file', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      cancellingSub({
        customer: {
          id: 'cus_1',
          invoice_settings: { default_payment_method: bankDebit('pm_ach') },
        },
      })
    );

    const result = await keepGiftMembership({ userId: 2 });
    expect(result).toEqual({ kept: false, portalUrl: 'https://checkout.stripe/setup' });
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    const [setup] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(setup).toMatchObject({ mode: 'setup', payment_method_types: ['card'] });
  });

  it('treats a legacy bank-account source as not a card', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      cancellingSub({
        customer: {
          id: 'cus_1',
          invoice_settings: { default_payment_method: null },
          default_source: { id: 'ba_1', object: 'bank_account' },
        },
      })
    );

    expect(await keepGiftMembership({ userId: 2 })).toMatchObject({ kept: false });
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('a session-cache outage after the gift change has committed', () => {
  // invalidateSubscriptionCaches already refreshes the session and tolerates its failure;
  // a refresh outside it would turn a committed change into a 500 for the user.
  beforeEach(async () => {
    const { refreshSession } = await import('~/server/auth/session-invalidation');
    vi.mocked(refreshSession).mockRejectedValue(new Error('session cache down'));
  });
  afterEach(async () => {
    const { refreshSession } = await import('~/server/auth/session-invalidation');
    vi.mocked(refreshSession).mockResolvedValue(undefined);
  });

  it('still accepts the gift', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Fulfilled',
      monthsRemaining: 3,
    });
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub({ tier: 'gold' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub());

    await expect(acceptMembershipGift({ giftId: 'gift_1', userId: 2 })).resolves.not.toThrow();
  });

  it('still keeps the membership', async () => {
    mockDbWrite.customerSubscription.findUnique.mockResolvedValue(dbSub());
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      ...stripeSub(),
      cancel_at: dayjs().add(30, 'day').unix(),
      default_payment_method: null,
      default_source: null,
      customer: {
        id: 'cus_1',
        invoice_settings: {
          default_payment_method: { id: 'pm_card', object: 'payment_method', type: 'card' },
        },
      },
    });

    expect(await keepGiftMembership({ userId: 2 })).toEqual({ kept: true });
  });

  it('still revokes the gift', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Fulfilled',
      monthsRemaining: 3,
    });

    expect(await revokeMembershipGift({ paymentIntentId: 'pi_1', reason: 'refund' })).toBe(true);
  });

  it('still hands over the owed months as a residual subscription', async () => {
    mockDbWrite.membershipGift.findMany.mockResolvedValue([{ id: 'gift_1' }]);
    mockDbWrite.membershipGift.findUnique.mockResolvedValue({
      ...baseGift,
      status: 'Active',
      tier: 'bronze',
      months: 3,
      monthsRemaining: 2,
      monthsConsumed: 1,
    });

    await expect(honorGiftResidualsForUser({ userId: 2 })).resolves.not.toThrow();
    expect(mockStripe.subscriptions.create).toHaveBeenCalled();
  });
});
