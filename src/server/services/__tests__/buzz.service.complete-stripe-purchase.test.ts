import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';

/**
 * `completeStripeBuzzTransaction` is reached from the browser as well as from the Stripe webhook,
 * so what it credits must come from the PaymentIntent the server created, not from the caller.
 * Stripe is faked with an in-memory PaymentIntent store so the metadata the service writes back
 * (`transactionId`) is what the next call reads.
 */

import type * as BuzzClient from '@civitai/buzz';
import type * as Caches from '~/server/redis/caches';

const h = vi.hoisted(() => ({
  intents: new Map<string, Record<string, any>>(),
  createTransaction: vi.fn(),
  multipliersFetch: vi.fn(),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userMultipliersCache: { fetch: h.multipliersFetch, refresh: vi.fn() },
}));

vi.mock('@civitai/buzz', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzClient>()),
  createBuzzClient: () => ({
    createTransaction: (...args: any[]) => h.createTransaction(...args),
  }),
}));

vi.mock('~/server/services/rewards-bonus-event.service', () => ({
  getActiveRewardsBonusEvent: async () => null,
}));

vi.mock('~/server/services/cosmetic.service', () => ({ grantCosmetics: vi.fn() }));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: async () => ({
    paymentIntents: {
      list: async () => ({ data: [...h.intents.values()].map((pi) => structuredClone(pi)) }),
      retrieve: async (id: string) => {
        const pi = h.intents.get(id);
        return pi ? structuredClone(pi) : null;
      },
      update: async (id: string, { metadata }: { metadata: Record<string, unknown> }) => {
        const pi = h.intents.get(id)!;
        pi.metadata = { ...pi.metadata, ...metadata };
        return structuredClone(pi);
      },
    },
  }),
}));

import { completeStripeBuzzTransaction } from '~/server/services/buzz.service';
import { getPaymentIntentsForBuzz } from '~/server/services/stripe.service';

const OWNER = 100;
const OTHER = 200;
const BUZZ = 5000;

// Stripe hands metadata back as strings.
function seedIntent(
  id: string,
  { metadata = {}, ...fields }: { metadata?: Record<string, string> } & Record<string, unknown> = {}
) {
  h.intents.set(id, {
    id,
    status: 'succeeded',
    amount: BUZZ / 10,
    currency: 'usd',
    metadata: {
      type: 'buzzPurchase',
      buzzAmount: String(BUZZ),
      unitAmount: String(BUZZ / 10),
      userId: String(OWNER),
      buzzType: 'yellow',
      ...metadata,
    },
    ...fields,
  });
  return id;
}

// The mod reprocess path passes userId through as the raw metadata string, as it did before.
const credits = () =>
  (h.createTransaction.mock.calls as [{ amount: number; toAccountId: number | string }][]).map(
    ([payload]) => ({ amount: payload.amount, toAccountId: Number(payload.toAccountId) })
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.intents.clear();
  h.multipliersFetch.mockResolvedValue({});
  let n = 0;
  h.createTransaction.mockImplementation(async () => ({ transactionId: `tx-${++n}` }));
});

describe('completeStripeBuzzTransaction — credits what was paid, to who paid it', () => {
  it('credits the purchased amount to the buyer (control)', async () => {
    const pi = seedIntent('pi_ok');

    await completeStripeBuzzTransaction({ amount: BUZZ, stripePaymentIntentId: pi, userId: OWNER });

    expect(credits()).toEqual([{ amount: BUZZ, toAccountId: OWNER }]);
  });

  it('credits once when the webhook and then the client complete the same purchase (control)', async () => {
    const pi = seedIntent('pi_webhook');

    // The webhook's call shape: amount and userId read from the PaymentIntent's metadata.
    await completeStripeBuzzTransaction({ amount: BUZZ, stripePaymentIntentId: pi, userId: OWNER });
    await completeStripeBuzzTransaction({ amount: BUZZ, stripePaymentIntentId: pi, userId: OWNER });

    expect(credits()).toEqual([{ amount: BUZZ, toAccountId: OWNER }]);
  });

  it('credits a non-USD purchase once through the webhook (control)', async () => {
    const pi = seedIntent('pi_eur', { currency: 'eur' });

    await completeStripeBuzzTransaction({ amount: BUZZ, stripePaymentIntentId: pi, userId: OWNER });

    expect(credits()).toEqual([{ amount: BUZZ, toAccountId: OWNER }]);
  });

  it('records the purchase details from the PaymentIntent, not from the caller', async () => {
    const pi = seedIntent('pi_details');

    await completeStripeBuzzTransaction({
      amount: BUZZ,
      stripePaymentIntentId: pi,
      userId: OWNER,
      details: { buzzType: 'blue', note: 'from the client' },
    });

    const [[payload]] = h.createTransaction.mock.calls as [[{ details: Record<string, unknown> }]];
    expect(payload.details).toMatchObject({ buzzType: 'yellow', stripePaymentIntentId: pi });
    expect(payload.details).not.toHaveProperty('note');
  });

  it('credits the mod reprocess call shape, which passes raw string metadata (control)', async () => {
    const pi = seedIntent('pi_reprocess');
    const { metadata } = h.intents.get(pi)!;

    await completeStripeBuzzTransaction({
      amount: metadata.buzzAmount,
      stripePaymentIntentId: pi,
      userId: metadata.userId,
    });

    expect(credits()).toEqual([{ amount: BUZZ, toAccountId: OWNER }]);
  });

  it('refuses a caller amount larger than the purchase and credits nothing', async () => {
    const pi = seedIntent('pi_inflated');

    await expect(
      completeStripeBuzzTransaction({
        amount: BUZZ * 100,
        stripePaymentIntentId: pi,
        userId: OWNER,
      })
    ).rejects.toThrow();
    expect(credits()).toEqual([]);
  });

  it('refuses a second, inflated call on an already completed purchase', async () => {
    const pi = seedIntent('pi_replay');

    await completeStripeBuzzTransaction({ amount: BUZZ, stripePaymentIntentId: pi, userId: OWNER });
    await completeStripeBuzzTransaction({
      amount: BUZZ * 100,
      stripePaymentIntentId: pi,
      userId: OWNER,
    }).catch(() => undefined);

    expect(credits()).toEqual([{ amount: BUZZ, toAccountId: OWNER }]);
  });

  it("refuses to credit another user's purchase to the caller", async () => {
    const pi = seedIntent('pi_someone_else');

    await expect(
      completeStripeBuzzTransaction({ amount: BUZZ, stripePaymentIntentId: pi, userId: OTHER })
    ).rejects.toThrow();
    expect(credits()).toEqual([]);
  });

  it('refuses a PaymentIntent that is not a Buzz purchase', async () => {
    const pi = seedIntent('pi_not_buzz', { metadata: { type: 'membershipGift' } });

    await expect(
      completeStripeBuzzTransaction({ amount: BUZZ, stripePaymentIntentId: pi, userId: OWNER })
    ).rejects.toThrow();
    expect(credits()).toEqual([]);
  });

  it('refuses a purchase whose Buzz amount does not match what was charged', async () => {
    const pi = seedIntent('pi_undercharged', { amount: 50 });

    await expect(
      completeStripeBuzzTransaction({ amount: BUZZ, stripePaymentIntentId: pi, userId: OWNER })
    ).rejects.toThrow();
    expect(credits()).toEqual([]);
  });
});

describe('getPaymentIntentsForBuzz — mod reprocess', () => {
  it('leaves a purchase with no recorded buyer uncredited and reports it', async () => {
    seedIntent('pi_legacy', { metadata: { userId: '' } });
    seedIntent('pi_pending');

    const result = await getPaymentIntentsForBuzz({});

    expect(credits()).toEqual([{ amount: BUZZ, toAccountId: OWNER }]);
    expect(result).toMatchObject({ legacyPaymentIntentIds: ['pi_legacy'] });
  });
});
