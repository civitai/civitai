import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';

/**
 * A Buzz purchase is credited as soon as its PaymentIntent succeeds, and a bank debit can come
 * back days later. So the methods a Buzz PaymentIntent offers are fixed server-side: never the
 * account's dashboard defaults (`automatic_payment_methods`) and never a list the client sends.
 */

const { mockPaymentIntentsCreate, mockGetServerStripe } = vi.hoisted(() => ({
  mockPaymentIntentsCreate: vi.fn(),
  mockGetServerStripe: vi.fn(),
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: (...args: unknown[]) => mockGetServerStripe(...args),
}));
vi.mock('~/server/services/blocks/attribution-validator.service', () => ({
  validateBuzzPurchaseAttribution: ({ metadata }: { metadata: Record<string, unknown> }) =>
    Promise.resolve(metadata),
}));

import { getPaymentIntent } from '../stripe.service';

const UNIT_AMOUNT = 1000;

async function createArgs({
  currency = 'USD',
  paymentMethodTypes,
  setupFuturePayment = true,
}: {
  currency?: string;
  paymentMethodTypes?: string[];
  setupFuturePayment?: boolean;
} = {}) {
  await getPaymentIntent({
    unitAmount: UNIT_AMOUNT,
    currency: currency as never,
    recaptchaToken: 'token',
    paymentMethodTypes,
    setupFuturePayment,
    metadata: {
      type: 'buzzPurchase',
      buzzAmount: UNIT_AMOUNT * 10,
      unitAmount: UNIT_AMOUNT,
      userId: 100,
    },
    user: { id: 100, email: 'buyer@example.com' },
    customerId: 'cus_test',
    domain: 'green',
  });

  return mockPaymentIntentsCreate.mock.calls[0]?.[0];
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

describe('getPaymentIntent — buzz payment methods', () => {
  it('offers card, link and cashapp, card first, as an explicit list', async () => {
    const args = await createArgs();

    expect(args.payment_method_types).toEqual(['card', 'link', 'cashapp']);
    expect(args.setup_future_usage).toBe('off_session');
  });

  it('never defers to the dashboard defaults, which include bank debits', async () => {
    const args = await createArgs();

    expect(args.automatic_payment_methods).toBeUndefined();
  });

  it('ignores a client-supplied list of payment methods', async () => {
    const args = await createArgs({ paymentMethodTypes: ['us_bank_account', 'acss_debit'] });

    expect(args.payment_method_types).toEqual(['card', 'link', 'cashapp']);
    expect(args.automatic_payment_methods).toBeUndefined();
  });

  it('offers no bank transfer when the buyer opts out of saving the method', async () => {
    const args = await createArgs({ setupFuturePayment: false });

    expect(args.payment_method_types).toEqual(['card', 'link', 'cashapp']);
    expect(args.setup_future_usage).toBeUndefined();
  });

  it('leaves out cashapp, which is USD-only, for any other currency', async () => {
    const args = await createArgs({ currency: 'USDC' });

    expect(args.payment_method_types).toEqual(['card', 'link']);
  });
});
