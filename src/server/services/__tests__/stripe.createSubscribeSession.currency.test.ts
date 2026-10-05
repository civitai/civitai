import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCError } from '@trpc/server';
import type * as GetServerStripeModule from '~/server/utils/get-server-stripe';
import type * as SessionInvalidationModule from '~/server/auth/session-invalidation';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Stripe pins a customer to ONE billing currency the first time they are invoiced
 * (`customer.currency`), and it is immutable. Every later subscription price for that
 * customer must be payable in it, or the call is rejected with
 *
 *   The price specified only supports `usd`. This doesn't match the expected currency: `aud`.
 *
 * That is a raw `StripeInvalidRequestError` thrown out of `checkout.sessions.create` /
 * `subscriptions.update`, so it reached the client as a tRPC INTERNAL_SERVER_ERROR (500).
 *
 * The membership IS purchasable in that currency: every membership Product carries an active
 * monthly sibling Price per supported currency, and the pricing page ships the whole set to
 * the browser. What the browser cannot know is which currency the customer is pinned to —
 * `customer.currency` is a Stripe-side fact with no representation in our database. So the
 * fix is a server-side substitution: resolve the sibling Price in the pinned currency and
 * charge that. These tests pin the substitution on BOTH paths (new Checkout session and
 * in-place plan change), the scoping of the lookup, the case normalisation, and the two
 * cases where no single correct answer exists and a typed error is the honest answer.
 */

const { mockGetServerStripe, mockRefreshSession } = vi.hoisted(() => ({
  mockGetServerStripe: vi.fn(),
  mockRefreshSession: vi.fn(),
}));

// Surgical: spread the original and override the one symbol, so a module that later gains
// an export does not turn this file into a collection failure reported as "no tests".
vi.mock('~/server/utils/get-server-stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof GetServerStripeModule>()),
  getServerStripe: (...args: unknown[]) => mockGetServerStripe(...args),
}));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidationModule>()),
  refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
}));
// The block-attribution validator has its own suite and pulls in the block registry. No
// test here passes a `blockAttribution`, so the stub is only keeping that import graph out.
vi.mock('~/server/services/blocks/attribution-validator.service', () => ({
  validateBuzzPurchaseAttribution: ({ metadata }: { metadata: Record<string, unknown> }) =>
    Promise.resolve(metadata),
}));
// Imported by stripe.service (getOrCreateVault) and unreachable from this function; mocked
// to cut the transitive common.service → caches → selectors → Prisma.validator chain.
vi.mock('~/server/services/vault.service', () => ({
  getOrCreateVault: vi.fn(),
}));

import { createSubscribeSession } from '../stripe.service';

const USER = { id: 100, email: 'buyer@example.com' };
// Deliberately not spelled with Stripe's real id prefixes where it would matter: nothing
// here parses a prefix, and secret scans treat those shapes as live identifiers.
const CUSTOMER_ID = 'customer_fixture';
const GOLD_PRODUCT_ID = 'product_fixture_gold';
const BRONZE_PRODUCT_ID = 'product_fixture_bronze';
const GOLD_PRICE_USD = 'fixture_gold_usd';
const GOLD_PRICE_AUD = 'fixture_gold_aud';
const GOLD_PRICE_AUD_QUARTERLY = 'fixture_gold_aud_quarterly';
const BRONZE_PRICE_USD = 'fixture_bronze_usd';

let mockCheckoutSessionsCreate: ReturnType<typeof vi.fn>;
let mockSubscriptionsUpdate: ReturnType<typeof vi.fn>;
let mockSubscriptionsList: ReturnType<typeof vi.fn>;
let mockCustomersRetrieve: ReturnType<typeof vi.fn>;
let mockPricesRetrieve: ReturnType<typeof vi.fn>;
let mockPricesList: ReturnType<typeof vi.fn>;

/**
 * @param customerCurrency what Stripe has pinned the customer to — `null` for a customer
 *   that has never been invoiced, which is the unconstrained case.
 * @param priceCurrency the currency of the Price the caller asked for.
 * @param currencyOptions extra currencies the requested Price itself can be paid in.
 * @param siblings what `prices.list` returns for the pinned currency.
 * @param withActiveBronzeSubscription when set, the customer already holds a plan, so the
 *   call takes the in-place `subscriptions.update` path instead of Checkout.
 */
function stubStripe({
  customerCurrency,
  priceCurrency = 'usd',
  currencyOptions,
  siblings = [],
  withActiveBronzeSubscription = false,
}: {
  customerCurrency: string | null;
  priceCurrency?: string;
  currencyOptions?: Record<string, unknown>;
  siblings?: Array<Record<string, unknown>>;
  withActiveBronzeSubscription?: boolean;
}) {
  mockSubscriptionsList.mockResolvedValue({
    data: withActiveBronzeSubscription
      ? [
          {
            id: 'subscription_fixture',
            status: 'active',
            items: {
              data: [
                {
                  id: 'subscription_item_fixture',
                  subscription: 'subscription_fixture',
                  price: { id: BRONZE_PRICE_USD, product: BRONZE_PRODUCT_ID },
                },
              ],
            },
          },
        ]
      : [],
  });
  mockCustomersRetrieve.mockResolvedValue({
    id: CUSTOMER_ID,
    // No `deleted` key: a real Stripe.Customer does not carry one — only DeletedCustomer
    // does, as `true`. The service reads it for falsiness, so absent is the truthful shape.
    currency: customerCurrency,
    // Set so the plan-change path never reaches the payment-method lookup.
    default_source: 'card_fixture',
  });
  mockPricesRetrieve.mockResolvedValue({
    id: GOLD_PRICE_USD,
    product: GOLD_PRODUCT_ID,
    currency: priceCurrency,
    // Monthly, billed every month — the shape every membership price has. Both fields are
    // load-bearing: the lookup filters on `interval` at the API and on `interval_count`
    // afterwards, because Stripe's list endpoint has no filter for the latter.
    recurring: { interval: 'month', interval_count: 1 },
    ...(currencyOptions ? { currency_options: currencyOptions } : {}),
  });
  mockPricesList.mockResolvedValue({ data: siblings });
}

/** The AUD sibling of the Gold monthly price, at a genuinely different amount. */
const AUD_SIBLING = {
  id: GOLD_PRICE_AUD,
  product: GOLD_PRODUCT_ID,
  currency: 'aud',
  unit_amount: 8000,
  recurring: { interval: 'month', interval_count: 1 },
};

async function subscribe() {
  return createSubscribeSession({
    priceId: GOLD_PRICE_USD,
    customerId: CUSTOMER_ID,
    user: USER,
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mockCheckoutSessionsCreate = vi.fn().mockResolvedValue({
    id: 'checkout_session_fixture',
    url: 'https://checkout.example.test/session',
  });
  mockSubscriptionsUpdate = vi.fn().mockResolvedValue({});
  mockSubscriptionsList = vi.fn();
  mockCustomersRetrieve = vi.fn();
  mockPricesRetrieve = vi.fn();
  mockPricesList = vi.fn();

  mockGetServerStripe.mockResolvedValue({
    checkout: { sessions: { create: mockCheckoutSessionsCreate } },
    subscriptions: {
      list: mockSubscriptionsList,
      update: mockSubscriptionsUpdate,
      resume: vi.fn(),
    },
    customers: { retrieve: mockCustomersRetrieve, update: vi.fn() },
    prices: { retrieve: mockPricesRetrieve, list: mockPricesList },
    paymentMethods: { list: vi.fn().mockResolvedValue({ data: [] }) },
    coupons: { create: vi.fn() },
  });
  mockRefreshSession.mockResolvedValue(undefined);

  // env.TIER_METADATA_KEY defaults to 'tier'; the filter keys off its presence.
  dbMock.dbRead.product.findMany.mockResolvedValue([
    { id: GOLD_PRODUCT_ID, metadata: { tier: 'gold' } },
    { id: BRONZE_PRODUCT_ID, metadata: { tier: 'bronze' } },
  ]);
});

describe('createSubscribeSession — charges the sibling price in the pinned currency', () => {
  it('sends Checkout the AUD price, not the USD one the caller asked for', async () => {
    // The whole point of the change. Before it, this call handed Stripe the USD price for a
    // customer Stripe will only bill in AUD, and the rejection came back as a 500.
    stubStripe({ customerCurrency: 'aud', siblings: [AUD_SIBLING] });

    await expect(subscribe()).resolves.toMatchObject({ sessionId: 'checkout_session_fixture' });

    expect(mockCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
    expect(mockCheckoutSessionsCreate.mock.calls[0][0].line_items).toEqual([
      { price: GOLD_PRICE_AUD, quantity: 1 },
    ]);
  });

  it('substitutes on the plan-change path too, which charges with no confirmation screen', async () => {
    // `subscriptions.update` rejects on a currency mismatch exactly as Checkout does, so a
    // substitution in front of only one of them would still 500 every pinned member's
    // upgrade — and this is the path that takes the money immediately.
    stubStripe({
      customerCurrency: 'aud',
      siblings: [AUD_SIBLING],
      withActiveBronzeSubscription: true,
    });

    await subscribe();

    expect(mockSubscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsUpdate.mock.calls[0][1].items).toEqual([
      { id: 'subscription_item_fixture', price: GOLD_PRICE_AUD },
    ]);
  });

  it('scopes the lookup to the same product, active, recurring and the same interval', async () => {
    // Each of these narrows a way the substitute could be the wrong thing to charge: another
    // tier, a retired price, a one-off, or a yearly plan standing in for a monthly one. The
    // product filter also keeps the lookup inside Stripe's own catalog — our Price table
    // holds rows for another payment provider under the same tier names.
    stubStripe({ customerCurrency: 'aud', siblings: [AUD_SIBLING] });

    await subscribe();

    expect(mockPricesList).toHaveBeenCalledTimes(1);
    expect(mockPricesList.mock.calls[0][0]).toMatchObject({
      product: GOLD_PRODUCT_ID,
      currency: 'aud',
      active: true,
      type: 'recurring',
      recurring: { interval: 'month' },
    });
  });

  it('will not substitute a price billed every 3 months for a monthly one', async () => {
    // `interval_count` is NOT a filter on Stripe's list endpoint, so it has to be applied
    // after the call. Without that, this quarterly price is the single candidate and gets
    // charged — 3x the billing period at an amount nobody picked.
    stubStripe({
      customerCurrency: 'aud',
      siblings: [
        {
          id: GOLD_PRICE_AUD_QUARTERLY,
          product: GOLD_PRODUCT_ID,
          currency: 'aud',
          unit_amount: 22000,
          recurring: { interval: 'month', interval_count: 3 },
        },
      ],
    });

    await expect(subscribe()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('normalises case on the customer side, so an upper-case pin still resolves', async () => {
    // Stripe documents `customer.currency` as lower-case, so this is defence rather than a
    // contract — but the value is compared against catalog data whose other payment provider
    // spells the same currencies in upper case, and the list call must be asked in the
    // currency Stripe expects regardless of what arrived.
    stubStripe({ customerCurrency: 'AUD', siblings: [AUD_SIBLING] });

    await subscribe();

    expect(mockPricesList.mock.calls[0][0]).toMatchObject({ currency: 'aud' });
    expect(mockCheckoutSessionsCreate.mock.calls[0][0].line_items).toEqual([
      { price: GOLD_PRICE_AUD, quantity: 1 },
    ]);
  });
});

describe('createSubscribeSession — leaves the requested price alone when it is payable', () => {
  it('proceeds for a customer Stripe has not pinned to a currency yet', async () => {
    stubStripe({ customerCurrency: null });

    await expect(subscribe()).resolves.toMatchObject({ sessionId: 'checkout_session_fixture' });
    expect(mockPricesList).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate.mock.calls[0][0].line_items).toEqual([
      { price: GOLD_PRICE_USD, quantity: 1 },
    ]);
  });

  it('proceeds when the currencies match, comparing case-insensitively on BOTH sides', async () => {
    // Vary BOTH operands in the one case: with only the customer side varied, dropping
    // `.toLowerCase()` from the price side survives the whole file, and the comment would be
    // claiming coverage the body does not provide.
    stubStripe({ customerCurrency: 'USD', priceCurrency: 'UsD' });

    await expect(subscribe()).resolves.toMatchObject({ sessionId: 'checkout_session_fixture' });
    expect(mockPricesList).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate.mock.calls[0][0].line_items).toEqual([
      { price: GOLD_PRICE_USD, quantity: 1 },
    ]);
  });

  it('proceeds when the requested price itself declares the customer currency', async () => {
    // A multi-currency Price is payable in every currency it declares, so there is nothing
    // to substitute. Our catalog does not use this today — but Stripe supports it, and
    // without the check, provisioning `currency_options` on a Price would turn a purchase
    // that works into a rejection.
    stubStripe({ customerCurrency: 'aud', currencyOptions: { aud: { unit_amount: 8000 } } });

    await expect(subscribe()).resolves.toMatchObject({ sessionId: 'checkout_session_fixture' });
    expect(mockPricesList).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate.mock.calls[0][0].line_items).toEqual([
      { price: GOLD_PRICE_USD, quantity: 1 },
    ]);
  });

  it('still substitutes when the price declares OTHER currencies but not the customer’s', async () => {
    // The half-provisioned Price: somebody adds EUR and GBP to the membership Price and not
    // AUD. A check that merely noticed `currency_options` EXISTS would wave this straight
    // into the Stripe 500, while every other test in this file stayed green — the
    // substitution cases never set the field, and the payable case only sets a MATCHING key.
    // Pins the key lookup, not the field's presence.
    stubStripe({
      customerCurrency: 'aud',
      currencyOptions: { eur: { unit_amount: 5000 }, gbp: { unit_amount: 4000 } },
      siblings: [AUD_SIBLING],
    });

    await subscribe();

    expect(mockCheckoutSessionsCreate.mock.calls[0][0].line_items).toEqual([
      { price: GOLD_PRICE_AUD, quantity: 1 },
    ]);
  });

  it('asks Stripe to expand currency_options, or the branch above can never fire live', async () => {
    // 🔴 The `currency_options` tests are only meaningful if the real API returns the field.
    // It is an EXPANDABLE field on Price — like `tiers`, omitted unless requested, which is
    // why the SDK types it optional while `currency` is not. A mock hands it over regardless,
    // so without this assertion that branch would be dead in production and every test above
    // it would still be green: the fixture would encode a shape the real call never produces.
    stubStripe({ customerCurrency: null });
    await subscribe();

    expect(mockPricesRetrieve).toHaveBeenCalledWith(
      GOLD_PRICE_USD,
      expect.objectContaining({ expand: expect.arrayContaining(['currency_options']) })
    );
  });
});

describe('createSubscribeSession — the two cases with no single right answer', () => {
  // The messages are asserted WHOLE rather than by keyword. These strings are the entire
  // user-facing output of this failure, and the previous version of this fix shipped a
  // message that told the customer the membership could not be purchased at all — which was
  // false. A keyword assertion cannot catch a reword back into a false claim; pinning the
  // string means a reword has to be deliberate.
  const NOT_SOLD_MESSAGE =
    'Your billing account is set up in AUD, and this membership is not currently sold in AUD. ' +
    "Stripe does not allow an account's billing currency to change once it is set. Please " +
    'contact support and we can look at the options for your account.';

  const AMBIGUOUS_MESSAGE =
    'We could not determine the price of this membership in AUD, the currency your billing ' +
    'account is set up in. Please contact support so we can correct it — you have not been ' +
    'charged.';

  it('rejects with a typed 4xx when the membership is genuinely not sold in the currency', async () => {
    stubStripe({ customerCurrency: 'aud', siblings: [] });

    const error = (await subscribe().catch((e) => e)) as TRPCError;

    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(NOT_SOLD_MESSAGE);
  });

  it('does not claim the membership cannot be purchased, because that was the false premise', async () => {
    // The refuted version of this fix asserted the purchase was impossible. It is not: the
    // sibling prices exist, and the tests above charge them. This one exists so the false
    // sentence cannot come back without a test going red.
    stubStripe({ customerCurrency: 'aud', siblings: [] });

    const error = (await subscribe().catch((e) => e)) as TRPCError;

    expect(error.message).not.toMatch(/cannot be purchased/i);
  });

  it('refuses rather than guessing when more than one active price matches', async () => {
    // Real catalogs grow duplicates. Picking one charges an amount nobody chose, and the
    // amounts in a duplicated row are not necessarily close to each other.
    stubStripe({
      customerCurrency: 'aud',
      siblings: [
        AUD_SIBLING,
        { ...AUD_SIBLING, id: 'fixture_gold_aud_duplicate', unit_amount: 88000 },
      ],
    });

    const error = (await subscribe().catch((e) => e)) as TRPCError;

    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(AMBIGUOUS_MESSAGE);
  });

  it('reaches neither Stripe charging call in either case', async () => {
    stubStripe({ customerCurrency: 'aud', siblings: [], withActiveBronzeSubscription: true });
    await subscribe().catch(() => undefined);

    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });
});
