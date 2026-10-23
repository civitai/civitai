import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * A Civitai AIR purchase is a Stripe payment link. Its `checkout.session.completed` must be answered,
 * or Stripe redelivers it, and must tell AIR about the checkout once, however often it is delivered.
 */

const { mockStripe, notifyAir, manageCheckoutPayment } = vi.hoisted(() => ({
  mockStripe: { webhooks: { constructEvent: vi.fn() } },
  notifyAir: vi.fn(),
  manageCheckoutPayment: vi.fn(),
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: vi.fn().mockResolvedValue(mockStripe),
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  trackWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/stripe.service', () => ({
  manageCheckoutPayment,
  manageInvoicePaid: vi.fn(),
  toDateTime: vi.fn(),
  upsertPriceRecord: vi.fn(),
  upsertProductRecord: vi.fn(),
  upsertSubscription: vi.fn(),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  syncFreshdeskMembership: vi.fn(),
  getPlans: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({ completeStripeBuzzTransaction: vi.fn() }));
vi.mock('~/server/services/integration.service', () => ({ notifyAir }));

import handler from '~/pages/api/webhooks/stripe';

const LINK = 'plink_air';
let claims: Set<string>;

const session = (over: Record<string, unknown> = {}) => ({
  id: 'cs_air_1',
  object: 'checkout.session',
  mode: 'payment',
  payment_link: LINK,
  customer_details: { email: 'buyer@example.com', name: 'Buyer' },
  customer_email: null,
  metadata: {},
  ...over,
});

async function deliver(object: unknown, eventId = 'evt_air_1') {
  mockStripe.webhooks.constructEvent.mockReturnValue({
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    livemode: true,
    data: { object },
  });
  const req = Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST',
    headers: { 'stripe-signature': 'sig' },
  });
  const res = {
    statusCode: 0,
    status: vi.fn(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function (this: any) {
      if (!this.statusCode) this.statusCode = 200;
      return this;
    }),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  };
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({ STRIPE_WEBHOOK_SECRET: 'whsec_test', AIR_PAYMENT_LINK_ID: LINK });
  claims = new Set();
  notifyAir.mockReset().mockResolvedValue(undefined);
  redisMock.sysRedis.set
    .mockReset()
    .mockImplementation(async (key: string, _v: string, opts: any) => {
      if (opts?.NX && claims.has(key)) return null;
      claims.add(key);
      return 'OK';
    });
  redisMock.sysRedis.del.mockReset().mockImplementation(async (key: string) => {
    claims.delete(key);
    return 1;
  });
});

describe('stripe webhook: Civitai AIR checkout', () => {
  it('answers, and tells AIR about the buyer', async () => {
    const res = await deliver(session());

    expect(res.statusCode).toBe(200);
    expect(notifyAir).toHaveBeenCalledWith({ email: 'buyer@example.com', name: 'Buyer' });
    expect(manageCheckoutPayment).not.toHaveBeenCalled();
  });

  it('tells AIR once when Stripe delivers the same checkout twice', async () => {
    const first = await deliver(session());
    const second = await deliver(session());

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(notifyAir).toHaveBeenCalledTimes(1);
  });

  it('asks Stripe to retry when AIR cannot be told, and tells it on the retry', async () => {
    notifyAir.mockRejectedValueOnce(new Error('AIR unavailable'));

    const first = await deliver(session());
    const retry = await deliver(session());

    expect(first.statusCode).toBe(400);
    expect(retry.statusCode).toBe(200);
    expect(notifyAir).toHaveBeenCalledTimes(2);
  });

  it('asks Stripe to retry, and tells AIR nothing, when the checkout cannot be claimed', async () => {
    redisMock.sysRedis.set.mockRejectedValueOnce(new Error('redis unavailable'));

    const res = await deliver(session());

    expect(res.statusCode).toBe(400);
    expect(notifyAir).not.toHaveBeenCalled();
  });

  it('answers, and tells AIR nothing, for a checkout without an email', async () => {
    const res = await deliver(session({ customer_details: { email: null, name: null } }));

    expect(res.statusCode).toBe(200);
    expect(notifyAir).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'air-no-email', eventId: 'evt_air_1' }),
      'webhooks'
    );
    expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain('buyer@example.com');
  });
});
