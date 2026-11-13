import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';

const mockDbWrite = dbMock.dbWrite;

const { mockStripe, mockManageCheckoutPayment, mockGetPlans } = vi.hoisted(() => ({
  mockStripe: {
    webhooks: { constructEvent: vi.fn() },
    subscriptions: {
      retrieve: vi.fn(),
      create: vi.fn(),
      del: vi.fn(),
      deleteDiscount: vi.fn(),
    },
    coupons: { retrieve: vi.fn(), create: vi.fn(), del: vi.fn() },
  },
  mockManageCheckoutPayment: vi.fn(),
  mockGetPlans: vi.fn(),
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: vi.fn().mockResolvedValue(mockStripe),
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  trackWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/stripe.service', () => ({
  manageCheckoutPayment: mockManageCheckoutPayment,
  manageInvoicePaid: vi.fn(),
  toDateTime: vi.fn(),
  upsertPriceRecord: vi.fn(),
  upsertProductRecord: vi.fn(),
  upsertSubscription: vi.fn().mockResolvedValue(undefined),
  createCustomer: vi.fn().mockResolvedValue('cus_recipient'),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  syncFreshdeskMembership: vi.fn().mockResolvedValue(undefined),
  getPlans: mockGetPlans,
}));
vi.mock('~/server/services/buzz.service', () => ({ completeStripeBuzzTransaction: vi.fn() }));
vi.mock('~/server/services/integration.service', () => ({ notifyAir: vi.fn() }));
vi.mock('~/server/services/referral.service', () => ({
  recordBuzzPurchaseKickback: vi.fn(),
  recordMembershipPaymentReward: vi.fn(),
  revokeForChargeback: vi.fn(),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  AttributionAppMissingError: class extends Error {},
  recordAttribution: vi.fn(),
  voidAttributionsForPayment: vi.fn(),
  voidSubscriptionAttributionsForInvoice: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/email/templates/membershipGiftReceived.email', () => ({
  membershipGiftReceivedEmail: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/server/email/templates/membershipGiftSent.email', () => ({
  membershipGiftSentEmail: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedUserContent: vi.fn() }));
vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));

import handler from '~/pages/api/webhooks/stripe';

type GiftRow = Record<string, unknown> & { status: string; monthsRemaining: number };

// One gift row the service reads and writes through dbWrite, so a sequence of events sees the
// state the previous one left.
let row: GiftRow;
const statusesWritten: string[] = [];

const seedGift = (overrides: Partial<GiftRow> = {}) => {
  row = {
    id: 'gift_1',
    gifterId: 1,
    recipientId: 2,
    holderId: 2,
    tier: 'gold',
    months: 3,
    status: 'Pending',
    message: null,
    anonymous: false,
    monthsRemaining: 0,
    monthsConsumed: 0,
    acceptedAt: null,
    armedCouponId: null,
    stripePaymentIntentId: null,
    stripeCouponId: null,
    stripeSubscriptionId: null,
    gifter: { id: 1, username: 'gifter', email: null },
    recipient: { id: 2, username: 'recipient', email: null },
    holder: { id: 2, email: 'r@x.com' },
    ...overrides,
  };
};

const giftSession = (
  paymentStatus: string,
  metadata: Record<string, string> = { type: 'membershipGift', giftId: 'gift_1' }
) => ({
  id: 'cs_1',
  object: 'checkout.session',
  mode: 'payment',
  payment_status: paymentStatus,
  payment_intent: 'pi_1',
  customer: 'cus_gifter',
  metadata,
});

async function deliver(type: string, object: unknown) {
  mockStripe.webhooks.constructEvent.mockReturnValue({
    id: 'evt_1',
    type,
    created: 0,
    livemode: false,
    data: { object },
  });
  const req = Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST',
    headers: { 'stripe-signature': 'sig' },
  });
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

const holderSubscriptionEnded = () =>
  deliver('customer.subscription.deleted', {
    id: 'sub_residual',
    customer: 'cus_recipient',
    cancel_at: 1,
  });

beforeEach(() => {
  vi.clearAllMocks();
  statusesWritten.length = 0;
  seedGift();
  envMock.set({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });

  mockDbWrite.membershipGift.findUnique.mockImplementation(async () => row);
  mockDbWrite.membershipGift.findMany.mockImplementation(async ({ where }: any) =>
    row.status === where.status && row.monthsRemaining > (where.monthsRemaining?.gt ?? -1)
      ? [row]
      : []
  );
  mockDbWrite.membershipGift.update.mockImplementation(async ({ data }: any) => {
    if (data.status) statusesWritten.push(data.status);
    row = { ...row, ...data };
    return row;
  });
  mockDbWrite.membershipGift.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (where.status && row.status !== where.status) return { count: 0 };
    if (data.status) statusesWritten.push(data.status);
    row = { ...row, ...data };
    return { count: 1 };
  });
  mockDbWrite.user.findFirst.mockResolvedValue({ id: 2 });
  mockGetPlans.mockResolvedValue([
    {
      id: 'prod_gold',
      price: { id: 'price_gold_usd', unitAmount: 5000, currency: 'usd' },
      prices: [{ id: 'price_gold_usd', unitAmount: 5000, currency: 'usd' }],
      metadata: { tier: 'gold' },
    },
  ]);
  mockStripe.subscriptions.del.mockResolvedValue({});
  mockStripe.subscriptions.create.mockResolvedValue({ id: 'sub_minted' });
  mockStripe.coupons.retrieve.mockRejectedValue(new Error('No such coupon'));
  mockStripe.coupons.create.mockImplementation(async (args: any) => args);
  mockStripe.coupons.del.mockResolvedValue({});
});

describe('stripe webhook: membership gift payments', () => {
  // A US bank debit completes Checkout 'unpaid' and settles days later, or bounces.
  it('does not fulfil a gift whose checkout completed unpaid', async () => {
    const res = await deliver('checkout.session.completed', giftSession('unpaid'));

    expect(statusesWritten).toEqual([]);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('fulfils a gift whose checkout completed paid', async () => {
    await deliver('checkout.session.completed', giftSession('paid'));

    expect(statusesWritten).toEqual(['Fulfilled']);
    expect(row).toMatchObject({ monthsRemaining: 3, stripePaymentIntentId: 'pi_1' });
  });

  // Gift checkout offers no promotion codes, so nothing should ever make a gift free.
  it('does not fulfil a gift whose checkout needed no payment', async () => {
    await deliver('checkout.session.completed', giftSession('no_payment_required'));

    expect(statusesWritten).toEqual([]);
  });

  it('fulfils a gift once its delayed payment succeeds', async () => {
    await deliver('checkout.session.completed', giftSession('unpaid'));
    expect(statusesWritten).toEqual([]);

    const res = await deliver('checkout.session.async_payment_succeeded', giftSession('paid'));

    expect(statusesWritten).toEqual(['Fulfilled']);
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('fulfils once when the delayed success is delivered twice', async () => {
    await deliver('checkout.session.async_payment_succeeded', giftSession('paid'));
    await deliver('checkout.session.async_payment_succeeded', giftSession('paid'));
    await deliver('checkout.session.completed', giftSession('paid'));

    expect(statusesWritten).toEqual(['Fulfilled']);
  });

  it('marks a never-fulfilled gift Failed when its delayed payment fails', async () => {
    await deliver('checkout.session.completed', giftSession('unpaid'));

    const res = await deliver('checkout.session.async_payment_failed', giftSession('unpaid'));

    expect(statusesWritten).toEqual(['Failed']);
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  // Deliberate: the row exists before its checkout does, so a failure matching no gift is an
  // anomaly. Refusing it keeps it visible as a failing delivery in Stripe instead of acked away.
  it('refuses a delayed failure for a gift it cannot find, so Stripe retries it', async () => {
    mockDbWrite.membershipGift.findUnique.mockResolvedValue(null);

    const res = await deliver('checkout.session.async_payment_failed', giftSession('unpaid'));

    expect(res.status).toHaveBeenCalledWith(400);
  });

  // Failed is terminal: a failed checkout's payment never clears, so no later event (a
  // redelivery, an out-of-order success) may turn the gift on.
  it('never fulfils a gift whose payment failed', async () => {
    seedGift({ status: 'Failed' });

    await deliver('checkout.session.completed', giftSession('paid'));
    await deliver('checkout.session.async_payment_succeeded', giftSession('paid'));

    expect(statusesWritten).toEqual([]);
  });

  describe('a gift fulfilled before its payment cleared, accepted by a recipient with no membership', () => {
    beforeEach(() =>
      seedGift({
        status: 'Completed',
        stripePaymentIntentId: 'pi_1',
        stripeSubscriptionId: 'sub_residual',
        stripeCouponId: 'gift_gift_1_residual',
      })
    );

    it('ends the membership it opened when the payment fails', async () => {
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_residual',
        status: 'active',
        metadata: { membershipGiftId: 'gift_1' },
      });

      await deliver('checkout.session.async_payment_failed', giftSession('unpaid'));

      expect(mockStripe.subscriptions.del).toHaveBeenCalledWith(
        'sub_residual',
        expect.objectContaining({ cancellation_details: { comment: 'membership-gift-revoked' } })
      );
      expect(mockStripe.coupons.del).toHaveBeenCalledWith('gift_gift_1_residual');
      expect(statusesWritten).toEqual(['Failed']);
      expect(row.monthsRemaining).toBe(0);
    });

    it('does nothing on a redelivered failure', async () => {
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_residual',
        status: 'active',
        metadata: { membershipGiftId: 'gift_1' },
      });
      await deliver('checkout.session.async_payment_failed', giftSession('unpaid'));
      vi.clearAllMocks();

      await deliver('checkout.session.async_payment_failed', giftSession('unpaid'));

      expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
      expect(mockStripe.subscriptions.del).not.toHaveBeenCalled();
      expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
    });
  });

  describe('a gift fulfilled before its payment cleared, riding on a membership the recipient pays for', () => {
    beforeEach(() => {
      seedGift({
        status: 'Active',
        monthsRemaining: 2,
        monthsConsumed: 1,
        acceptedAt: new Date(),
        stripePaymentIntentId: 'pi_1',
        armedCouponId: 'gift_gift_1_m2',
      });
      mockDbWrite.customerSubscription.findUnique.mockResolvedValue({
        id: 'sub_own',
        status: 'active',
        product: { id: 'prod_gold', provider: 'Stripe', metadata: { tier: 'gold' } },
        price: { id: 'price_gold_usd', interval: 'month', currency: 'usd' },
      });
      mockStripe.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_own',
        status: 'active',
        discount: { coupon: { id: 'gift_gift_1_m2' } },
      });
    });

    it('takes the gifted month off their subscription when the payment fails', async () => {
      await deliver('checkout.session.async_payment_failed', giftSession('unpaid'));

      expect(mockStripe.subscriptions.deleteDiscount).toHaveBeenCalledWith('sub_own');
      expect(mockStripe.coupons.del).toHaveBeenCalledWith('gift_gift_1_m2');
      expect(statusesWritten).toEqual(['Failed']);
    });

    it('does not mint the cancelled months when their membership later ends', async () => {
      await deliver('checkout.session.async_payment_failed', giftSession('unpaid'));

      await holderSubscriptionEnded();

      expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
    });

    // Control for the test above: with the failure never delivered, the same ending mints.
    it('mints the owed months when their membership ends and the payment never failed', async () => {
      await holderSubscriptionEnded();

      expect(mockStripe.subscriptions.create).toHaveBeenCalledTimes(1);
    });
  });

  // Stripe retries a 400 for days, so routing a non-gift async event to the gift service
  // would turn every delayed non-gift payment into a retry storm.
  it('leaves a non-gift checkout to the existing path', async () => {
    for (const [type, status] of [
      ['checkout.session.completed', 'unpaid'],
      ['checkout.session.async_payment_failed', 'unpaid'],
      ['checkout.session.async_payment_succeeded', 'paid'],
    ]) {
      const res = await deliver(type, giftSession(status, {}));
      expect(res.status, type).not.toHaveBeenCalledWith(400);
    }

    expect(mockManageCheckoutPayment).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.membershipGift.findUnique).not.toHaveBeenCalled();
  });
});
