import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as KyselyDb from '~/server/db/kyselyDb';
import { envMock } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * A Civitai AIR purchase is a Stripe payment link. Its `checkout.session.completed` must be answered,
 * or Stripe redelivers it, and must tell AIR about the checkout once, however often it is delivered.
 */

const { mockStripe, notifyAir, manageCheckoutPayment, h } = vi.hoisted(() => ({
  mockStripe: { webhooks: { constructEvent: vi.fn() } },
  notifyAir: vi.fn(),
  manageCheckoutPayment: vi.fn(),
  h: { isFlipt: vi.fn(async () => false), pg: null as unknown as PGlite },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: h.isFlipt,
}));
vi.mock('~/server/db/kyselyDb', async (importOriginal) => {
  const { pgliteKysely } = await import('~/__tests__/pglite-kysely');
  return { ...(await importOriginal<typeof KyselyDb>()), kyselyWrite: pgliteKysely(() => h.pg) };
});

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

const loggedText = () => JSON.stringify(loggingMock.logToAxiom.mock.calls);

beforeEach(() => {
  vi.clearAllMocks();
  h.isFlipt.mockResolvedValue(false);
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
    expect(loggedText()).not.toContain('buyer@example.com');
  });

  it('tells AIR once when Stripe delivers the same checkout twice', async () => {
    const first = await deliver(session());
    const second = await deliver(session());

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(notifyAir).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain('buyer@example.com');
  });

  it('asks Stripe to retry when AIR cannot be told, and tells it on the retry', async () => {
    notifyAir.mockRejectedValueOnce(new Error('AIR unavailable'));

    const first = await deliver(session());
    const retry = await deliver(session());

    expect(first.statusCode).toBe(400);
    expect(retry.statusCode).toBe(200);
    expect(notifyAir).toHaveBeenCalledTimes(2);
    expect(loggedText()).not.toContain('buyer@example.com');
  });

  it('logs an error, and still asks Stripe to retry, when the claim cannot be released', async () => {
    notifyAir.mockRejectedValueOnce(new Error('AIR unavailable'));
    redisMock.sysRedis.del.mockRejectedValueOnce(new Error('redis unavailable'));

    const res = await deliver(session());

    expect(res.statusCode).toBe(400);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        stage: 'air-claim-release-failed',
        checkoutSessionId: 'cs_air_1',
      }),
      'webhooks'
    );
    expect(loggedText()).not.toContain('buyer@example.com');
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
  });
});

describe('stripe webhook: Civitai AIR checkout, with the idempotency-keys-pg flag', () => {
  let withTable: PGlite;
  let withoutTable: PGlite;
  const rows = async () =>
    (
      await withTable.query<{ scope: string; key: string }>(
        'SELECT scope, key FROM "IdempotencyKey"'
      )
    ).rows;

  beforeAll(async () => {
    withTable = new PGlite();
    await withTable.exec(
      readFileSync(
        path.resolve(
          __dirname,
          '../../../packages/civitai-db-schema/prisma/migrations/20271119120000_idempotency_key/migration.sql'
        ),
        'utf8'
      )
    );
    withoutTable = new PGlite();
  });
  afterAll(async () => {
    await withTable?.close();
    await withoutTable?.close();
  });
  beforeEach(async () => {
    h.pg = withTable;
    await withTable.exec('DELETE FROM "IdempotencyKey"');
  });
  afterEach(() => {
    h.isFlipt.mockResolvedValue(false);
  });

  it('off: claims in sysRedis exactly as before, and Postgres is not touched', async () => {
    await deliver(session());

    expect(redisMock.sysRedis.set.mock.calls).toEqual([
      ['webhooks:stripe:air-notified:cs_air_1', '1', { NX: true, EX: 2592000 }],
    ]);
    expect(await rows()).toEqual([]);
  });

  it('on: tells AIR once when Stripe redelivers after sysRedis lost the claim', async () => {
    h.isFlipt.mockResolvedValue(true);
    const first = await deliver(session());
    claims.clear(); // sysRedis evicted the claim (volatile-lru)
    const second = await deliver(session());

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(notifyAir).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([{ scope: 'stripe-air', key: 'cs_air_1' }]);
  });

  it('on: a claim sysRedis took before the flag was turned on still holds', async () => {
    h.isFlipt.mockResolvedValue(true);
    claims.add('webhooks:stripe:air-notified:cs_air_1');

    const res = await deliver(session());

    expect(res.statusCode).toBe(200);
    expect(notifyAir).not.toHaveBeenCalled();
  });

  it('on: frees the claim when AIR cannot be told, and tells it on the retry', async () => {
    h.isFlipt.mockResolvedValue(true);
    notifyAir.mockRejectedValueOnce(new Error('AIR unavailable'));

    const first = await deliver(session());
    const retry = await deliver(session());

    expect([first.statusCode, retry.statusCode]).toEqual([400, 200]);
    expect(notifyAir).toHaveBeenCalledTimes(2);
  });

  it('on, with the table missing: asks Stripe to retry, and tells AIR nothing', async () => {
    h.isFlipt.mockResolvedValue(true);
    h.pg = withoutTable;

    const res = await deliver(session());

    expect(res.statusCode).toBe(400);
    expect(notifyAir).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });
});
