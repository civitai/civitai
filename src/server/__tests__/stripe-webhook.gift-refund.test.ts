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
    paymentIntents: { retrieve: vi.fn() },
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
  revokeForChargeback: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  AttributionAppMissingError: class extends Error {},
  recordAttribution: vi.fn(),
  voidAttributionsForPayment: vi.fn().mockResolvedValue(0),
  voidSubscriptionAttributionsForInvoice: vi.fn().mockResolvedValue(0),
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

let row: Record<string, any>;

// A Pending gift: paid, never fulfilled, and the refund endpoint has written its PaymentIntent.
const seedGift = (overrides: Record<string, unknown> = {}) => {
  row = {
    id: 'gift_1',
    gifterId: 1,
    recipientId: 2,
    holderId: 2,
    tier: 'gold',
    months: 3,
    status: 'Pending',
    monthsRemaining: 0,
    monthsConsumed: 0,
    armedCouponId: null,
    armedAt: null,
    stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1',
    stripeCouponId: null,
    stripeSubscriptionId: null,
    ...overrides,
  };
};

// Shaped like a real charge.refunded event body (trimmed).
const refundedCharge = (over: Record<string, unknown> = {}) => ({
  id: 'ch_1',
  object: 'charge',
  amount: 15000,
  amount_captured: 15000,
  amount_refunded: 15000,
  captured: true,
  currency: 'usd',
  customer: 'cus_gifter',
  invoice: null,
  livemode: true,
  metadata: {},
  paid: true,
  payment_intent: 'pi_1',
  payment_method_details: { type: 'card', card: { brand: 'visa' } },
  refunded: true,
  status: 'succeeded',
  ...over,
});

async function deliver(type: string, object: unknown) {
  mockStripe.webhooks.constructEvent.mockReturnValue({
    id: 'evt_1',
    object: 'event',
    api_version: '2025-03-31.basil',
    type,
    created: 0,
    livemode: true,
    pending_webhooks: 1,
    data: { object, previous_attributes: { amount_refunded: 0, refunded: false } },
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

const matches = (where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => row[k] === v);

beforeEach(() => {
  vi.clearAllMocks();
  seedGift();
  envMock.set({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
  mockDbWrite.membershipGift.findUnique.mockImplementation(async ({ where }: any) =>
    matches(where) ? row : null
  );
  mockDbWrite.membershipGift.update.mockImplementation(async ({ where, data }: any) => {
    if (!matches(where)) throw new Error('P2025');
    row = { ...row, ...data };
    return row;
  });
  mockStripe.paymentIntents.retrieve.mockResolvedValue({
    id: 'pi_1',
    object: 'payment_intent',
    status: 'succeeded',
    metadata: { type: 'membershipGift', giftId: 'gift_1' },
  });
});

describe('charge.refunded on a membership gift', () => {
  it('marks a Pending gift Refunded', async () => {
    const res = await deliver('charge.refunded', refundedCharge());

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(row.status).toBe('Refunded');
  });

  it('marks a Pending gift Refunded when payment_intent is expanded', async () => {
    await deliver(
      'charge.refunded',
      refundedCharge({ payment_intent: { id: 'pi_1', object: 'payment_intent' } })
    );

    expect(row.status).toBe('Refunded');
  });

  // The refund endpoint marks the gift itself, so this delivery usually lands on a Refunded row.
  it('changes nothing for a gift the refund endpoint already marked', async () => {
    seedGift({ status: 'Refunded' });

    const res = await deliver('charge.refunded', refundedCharge());

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(mockDbWrite.membershipGift.update).not.toHaveBeenCalled();
  });
});
