import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The currency a real-money Buzz purchase is credited in must be derived from the domain the
 * request arrived on, never taken from the client.
 *
 * The browser builds the payment-intent metadata and stamps `buzzType` into it; the Stripe webhook
 * later credits whatever colour it finds there. Nothing in between re-derived it, so a modified
 * client could pick the colour its purchase landed in — including `blue`, the FREE currency.
 * `getPaymentIntent` is the last point that still knows the request's domain, so the override lives
 * there and these tests assert on what is handed to `paymentIntents.create`.
 */

const { mockPaymentIntentsCreate, mockGetServerStripe } = vi.hoisted(() => ({
  mockPaymentIntentsCreate: vi.fn(),
  mockGetServerStripe: vi.fn(),
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: (...args: unknown[]) => mockGetServerStripe(...args),
}));
// The block-attribution validator has its own suite and pulls in the block registry. Pass the
// metadata through untouched so the only thing this file can be measuring is the buzzType override.
vi.mock('~/server/services/blocks/attribution-validator.service', () => ({
  validateBuzzPurchaseAttribution: ({ metadata }: { metadata: Record<string, unknown> }) =>
    Promise.resolve(metadata),
}));

import { getPaymentIntent } from '../stripe.service';

const USER = { id: 100, email: 'buyer@example.com' };
const CUSTOMER_ID = 'cus_test';
const UNIT_AMOUNT = 1000;

async function purchase({
  domain,
  buzzType,
}: {
  domain: 'green' | 'blue' | 'red';
  buzzType?: 'green' | 'yellow' | 'blue' | 'red';
}) {
  await getPaymentIntent({
    unitAmount: UNIT_AMOUNT,
    currency: 'USD' as never,
    recaptchaToken: 'token',
    setupFuturePayment: true,
    metadata: {
      type: 'buzzPurchase',
      // buzzAmount must be unitAmount * 10 or the amount-tamper guard rejects the purchase first.
      buzzAmount: UNIT_AMOUNT * 10,
      unitAmount: UNIT_AMOUNT,
      userId: USER.id,
      ...(buzzType ? { buzzType } : {}),
    },
    user: USER,
    // Supplied so the run never reaches createCustomer, which would hit Stripe and the db.
    customerId: CUSTOMER_ID,
    domain,
  });

  return mockPaymentIntentsCreate.mock.calls[0]?.[0]?.metadata?.buzzType;
}

function overrideLogs() {
  return (loggingMock.logToAxiom.mock.calls as [{ name?: string }][]).filter(
    ([payload]) => payload?.name === 'buzz-purchase-currency'
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPaymentIntentsCreate.mockResolvedValue({
    client_secret: 'secret',
    payment_method_types: ['card'],
  });
  mockGetServerStripe.mockResolvedValue({
    paymentIntents: { create: mockPaymentIntentsCreate },
  });
});

describe('getPaymentIntent — buzz purchase currency', () => {
  it('credits green on the green domain even when the client asks for yellow', async () => {
    expect(await purchase({ domain: 'green', buzzType: 'yellow' })).toBe('green');
  });

  it('credits yellow off-green even when the client asks for green', async () => {
    expect(await purchase({ domain: 'blue', buzzType: 'green' })).toBe('yellow');
  });

  it('never credits blue, the free currency, however the client asks', async () => {
    expect(await purchase({ domain: 'red', buzzType: 'blue' })).toBe('yellow');
    mockPaymentIntentsCreate.mockClear();
    expect(await purchase({ domain: 'green', buzzType: 'blue' })).toBe('green');
  });

  it('stamps a currency when the client omits one, rather than leaving it to a downstream default', async () => {
    expect(await purchase({ domain: 'green' })).toBe('green');
    mockPaymentIntentsCreate.mockClear();
    expect(await purchase({ domain: 'blue' })).toBe('yellow');
  });

  it('logs the override so a modified client is visible', async () => {
    await purchase({ domain: 'green', buzzType: 'blue' });

    expect(overrideLogs()).toHaveLength(1);
    expect(overrideLogs()[0][0]).toMatchObject({
      userId: USER.id,
      domain: 'green',
      clientBuzzType: 'blue',
      derivedBuzzType: 'green',
    });
  });

  it('stays quiet when the client asked for the currency it was going to get', async () => {
    await purchase({ domain: 'green', buzzType: 'green' });

    expect(overrideLogs()).toHaveLength(0);
  });
});
