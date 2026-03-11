import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';

// Use vi.hoisted so mocks are available inside vi.mock factories
const {
  mockDbRead,
  mockDbWrite,
  mockNowpaymentsCaller,
  mockGrantBuzzPurchase,
  mockSignalClient,
  mockWithDistributedLock,
} = vi.hoisted(() => {
  const mockCryptoWallet = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  };

  return {
    mockDbRead: {
      cryptoWallet: { findUnique: vi.fn() },
      cryptoDepositFee: { findMany: vi.fn().mockResolvedValue([]) },
    },
    mockDbWrite: {
      cryptoWallet: mockCryptoWallet,
      cryptoDepositFee: { upsert: vi.fn().mockResolvedValue({}) },
    },
    mockNowpaymentsCaller: {
      createPayment: vi.fn(),
      getPaymentStatus: vi.fn(),
      getMerchantCoins: vi.fn(),
      getFullCurrencies: vi.fn(),
      getMinimumPaymentAmount: vi.fn(),
    },
    mockGrantBuzzPurchase: vi.fn().mockResolvedValue('tx_123'),
    mockSignalClient: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    mockWithDistributedLock: vi.fn(async (_opts: any, fn: () => Promise<any>) => fn()),
  };
});

// Mock modules
vi.mock('~/env/server', () => ({
  env: { NEXTAUTH_URL: 'https://civitai.com' },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({
  default: mockNowpaymentsCaller,
}));

vi.mock('~/server/services/buzz.service', () => ({
  grantBuzzPurchase: mockGrantBuzzPurchase,
}));

vi.mock('~/utils/signal-client', () => ({
  signalClient: mockSignalClient,
}));

vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: mockWithDistributedLock,
}));

vi.mock('~/server/common/enums', () => ({
  SignalMessages: { CryptoDepositUpdate: 'crypto-deposit:update' },
}));

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    del: vi.fn().mockResolvedValue(1),
  },
  REDIS_KEYS: {
    CACHES: {
      SUPPORTED_CRYPTO_CURRENCIES: 'packed:caches:supported-crypto-currencies',
      CRYPTO_PAYMENT_STATUS: 'packed:caches:crypto-payment-status',
    },
  },
}));

vi.mock('~/server/common/constants', () => ({
  CacheTTL: { sm: 180, hour: 3600 },
}));

vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
}));

// Import after mocks
import {
  createDepositAddress,
  processDeposit,
  getDepositHistory,
} from '~/server/services/nowpayments.service';

// Helper to build a webhook event
function makeWebhookEvent(
  overrides: Partial<NOWPayments.WebhookEvent> = {}
): NOWPayments.WebhookEvent {
  return {
    payment_id: 12345,
    payment_status: 'finished',
    order_id: 'user:42',
    actually_paid: 10,
    pay_currency: 'btc',
    outcome_amount: 9.5,
    outcome_currency: 'usdcbase',
    price_amount: 10,
    price_currency: 'usd',
    ...overrides,
  };
}

// ─── processDeposit ──────────────────────────────────────────────────────────

describe('processDeposit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses userId from order_id and sends signal', async () => {
    const event = makeWebhookEvent({ payment_status: 'confirming' });
    const result = await processDeposit(12345, 'confirming', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 0 });
    expect(mockSignalClient.send).toHaveBeenCalledWith({
      userId: 42,
      target: 'crypto-deposit:update',
      data: {
        paymentId: 12345,
        status: 'confirming',
        amount: 10,
        currency: 'btc',
        outcomeAmount: 9.5,
      },
    });
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('grants buzz only on finished status', async () => {
    const event = makeWebhookEvent({ outcome_amount: 5.0 });
    const result = await processDeposit(12345, 'finished', event);

    // 5.0 USDC * 1000 = 5000 buzz
    expect(result).toEqual({ userId: 42, buzzAmount: 5000, transactionId: 'tx_123' });
    expect(mockGrantBuzzPurchase).toHaveBeenCalledWith({
      userId: 42,
      amount: 5000,
      externalTransactionId: 'np-deposit-12345',
      provider: 'nowpayments',
      paymentId: 12345,
    });
  });

  it('does not grant buzz on confirmed status', async () => {
    const event = makeWebhookEvent({ payment_status: 'confirmed', outcome_amount: 5.0 });
    const result = await processDeposit(12345, 'confirmed', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 0 });
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('calculates buzz correctly: floors fractional amounts', async () => {
    // 7.999 USDC * 1000 = 7999 buzz (floored)
    const event = makeWebhookEvent({ outcome_amount: 7.999 });
    const result = await processDeposit(12345, 'finished', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 7999, transactionId: 'tx_123' });
  });

  it('calculates buzz correctly: 1 USDC = 1000 buzz', async () => {
    const event = makeWebhookEvent({ outcome_amount: 1.0 });
    const result = await processDeposit(12345, 'finished', event);

    expect(result?.buzzAmount).toBe(1000);
  });

  it('calculates buzz correctly: large amounts', async () => {
    // $100 worth = 100,000 buzz
    const event = makeWebhookEvent({ outcome_amount: 100.0 });
    const result = await processDeposit(12345, 'finished', event);

    expect(result?.buzzAmount).toBe(100000);
  });

  it('handles zero outcome_amount on finished', async () => {
    const event = makeWebhookEvent({ outcome_amount: 0 });
    const result = await processDeposit(12345, 'finished', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 0 });
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('handles null outcome_amount on finished', async () => {
    const event = makeWebhookEvent({ outcome_amount: null });
    const result = await processDeposit(12345, 'finished', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 0 });
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('throws on missing order_id', async () => {
    const event = makeWebhookEvent({ order_id: null });
    await expect(processDeposit(12345, 'finished', event)).rejects.toThrow(
      'Invalid order_id format'
    );
  });

  it('throws on invalid order_id format', async () => {
    const event = makeWebhookEvent({ order_id: 'invalid-format' });
    await expect(processDeposit(12345, 'finished', event)).rejects.toThrow(
      'Invalid order_id format'
    );
  });

  it('throws on non-numeric userId in order_id', async () => {
    const event = makeWebhookEvent({ order_id: 'user:abc' });
    await expect(processDeposit(12345, 'finished', event)).rejects.toThrow(
      'Invalid userId in order_id'
    );
  });

  it('uses externalTransactionId with payment_id for idempotency', async () => {
    const event = makeWebhookEvent({ outcome_amount: 5.0 });
    await processDeposit(99999, 'finished', event);

    expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionId: 'np-deposit-99999',
      })
    );
  });

  it('stores fee data from webhook on finished status', async () => {
    const event = makeWebhookEvent({
      outcome_amount: 9.5,
      actually_paid_at_fiat: 10.0,
      fee: {
        currency: 'usdcbase',
        depositFee: '0.25',
        serviceFee: '0.15',
        withdrawalFee: '0',
      },
    });
    await processDeposit(12345, 'finished', event);

    expect(mockDbWrite.cryptoDepositFee.upsert).toHaveBeenCalledWith({
      where: { paymentId: 12345 },
      create: {
        paymentId: 12345,
        depositFee: 0.25,
        serviceFee: 0.15,
        feeCurrency: 'usdcbase',
        paidFiat: 10.0,
      },
      update: {
        depositFee: 0.25,
        serviceFee: 0.15,
        feeCurrency: 'usdcbase',
        paidFiat: 10.0,
      },
    });
  });

  it('does not store fee data on non-finished status', async () => {
    const event = makeWebhookEvent({ payment_status: 'confirming' });
    await processDeposit(12345, 'confirming', event);

    expect(mockDbWrite.cryptoDepositFee.upsert).not.toHaveBeenCalled();
  });

  it('handles missing fee object gracefully', async () => {
    const event = makeWebhookEvent({ outcome_amount: 5.0, fee: null });
    await processDeposit(12345, 'finished', event);

    expect(mockDbWrite.cryptoDepositFee.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          depositFee: 0,
          serviceFee: 0,
          feeCurrency: 'usdcbase',
        }),
      })
    );
  });
});

// ─── createDepositAddress ────────────────────────────────────────────────────

describe('createDepositAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing wallet without calling NowPayments', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xExistingAddress',
      smartAccount: '12345',
    });

    const result = await createDepositAddress(42);

    expect(result).toEqual({ address: '0xExistingAddress', paymentId: 12345 });
    expect(mockNowpaymentsCaller.createPayment).not.toHaveBeenCalled();
  });

  it('creates new wallet via NowPayments when none exists', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue(null);
    mockNowpaymentsCaller.createPayment.mockResolvedValue({
      pay_address: '0xNewAddress',
      payment_id: 67890,
    });

    const result = await createDepositAddress(42);

    expect(result).toEqual({ address: '0xNewAddress', paymentId: 67890 });
    expect(mockNowpaymentsCaller.createPayment).toHaveBeenCalledWith({
      price_amount: 1,
      price_currency: 'usd',
      pay_currency: 'usdcbase',
      order_id: 'user:42',
      ipn_callback_url: 'https://civitai.com/api/webhooks/nowpayments',
    });
    expect(mockDbWrite.cryptoWallet.upsert).toHaveBeenCalledWith({
      where: { userId: 42 },
      create: {
        userId: 42,
        wallet: '0xNewAddress',
        smartAccount: '67890',
      },
      update: {
        wallet: '0xNewAddress',
        smartAccount: '67890',
      },
    });
  });

  it('uses distributed lock for creation', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue(null);
    mockNowpaymentsCaller.createPayment.mockResolvedValue({
      pay_address: '0xNewAddress',
      payment_id: 67890,
    });

    await createDepositAddress(42);

    expect(mockWithDistributedLock).toHaveBeenCalledWith(
      { key: 'crypto-deposit:create:42' },
      expect.any(Function)
    );
  });

  it('throws when NowPayments returns null', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue(null);
    mockNowpaymentsCaller.createPayment.mockResolvedValue(null);

    await expect(createDepositAddress(42)).rejects.toThrow(
      'Failed to create deposit address via NowPayments'
    );
  });

  it('handles null smartAccount on existing wallet', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xExistingAddress',
      smartAccount: null,
    });

    // wallet exists but smartAccount is null — still returns the address
    const result = await createDepositAddress(42);
    expect(result).toEqual({ address: '0xExistingAddress', paymentId: null });
  });
});

// ─── getDepositHistory ───────────────────────────────────────────────────────

describe('getDepositHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when no wallet exists', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue(null);

    const result = await getDepositHistory(42);
    expect(result).toEqual({ deposits: [], total: 0 });
  });

  it('returns empty when wallet has no smartAccount', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: null,
    });

    const result = await getDepositHistory(42);
    expect(result).toEqual({ deposits: [], total: 0 });
  });

  it('includes parent payment when it has been paid', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: '100',
    });

    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValue({
      payment_id: 100,
      payment_status: 'finished',
      actually_paid: 1,
      pay_amount: 1,
      pay_currency: 'usdcbase',
      outcome_amount: 0.99,
      created_at: '2025-01-01T00:00:00Z',
      payment_extra_ids: undefined, // No child payments yet
    });

    const result = await getDepositHistory(42, 1, 3);

    expect(result.total).toBe(1);
    expect(result.deposits).toHaveLength(1);
    expect(result.deposits[0]?.paymentId).toBe(100);
    expect(result.deposits[0]?.buzzCredited).toBe(990); // 0.99 * 1000 floored
  });

  it('excludes parent payment when it has not been paid', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: '100',
    });

    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValue({
      payment_id: 100,
      payment_status: 'waiting',
      actually_paid: 0,
      pay_amount: 1,
      pay_currency: 'usdcbase',
      outcome_amount: 0,
      created_at: '2025-01-01T00:00:00Z',
      payment_extra_ids: undefined,
    });

    const result = await getDepositHistory(42, 1, 3);
    expect(result.total).toBe(0);
    expect(result.deposits).toHaveLength(0);
  });

  it('includes both parent and child payments, newest-first', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: '100',
    });

    mockNowpaymentsCaller.getPaymentStatus.mockImplementation(async (id: string | number) => {
      const numId = typeof id === 'string' ? Number(id) : id;
      if (numId === 100) {
        // Parent payment (also paid)
        return {
          payment_id: 100,
          payment_extra_ids: [101, 102, 103, 104, 105],
          payment_status: 'finished',
          actually_paid: 1,
          pay_amount: 1,
          pay_currency: 'usdcbase',
          outcome_amount: 0.99,
          created_at: '2025-01-01T00:00:00Z',
        };
      }
      // Child payments
      return {
        payment_id: numId,
        payment_status: 'finished',
        actually_paid: 10,
        pay_amount: 10,
        pay_currency: 'btc',
        outcome_amount: 9.5,
        created_at: `2025-01-0${numId - 100}T00:00:00Z`,
      };
    });

    // 5 children + 1 parent = 6 total, page 1 perPage 3 => IDs 105, 104, 103
    const result = await getDepositHistory(42, 1, 3);

    expect(result.total).toBe(6);
    expect(result.deposits).toHaveLength(3);
    expect(result.deposits[0]?.paymentId).toBe(105);
    expect(result.deposits[1]?.paymentId).toBe(104);
    expect(result.deposits[2]?.paymentId).toBe(103);
  });

  it('fetches parent payment via cache (dedup handled by Redis in production)', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: '100',
    });

    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValue({
      payment_id: 100,
      payment_status: 'finished',
      actually_paid: 5,
      pay_amount: 5,
      pay_currency: 'usdcbase',
      outcome_amount: 4.95,
      created_at: '2025-01-01T00:00:00Z',
      payment_extra_ids: undefined,
    });

    const result = await getDepositHistory(42, 1, 10);

    // Parent payment appears as a deposit when it has been paid
    expect(result.deposits).toHaveLength(1);
    expect(result.deposits[0]?.paymentId).toBe(100);
  });

  it('calculates buzzCredited only for finished deposits', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: '100',
    });

    mockNowpaymentsCaller.getPaymentStatus.mockImplementation(async (id: string | number) => {
      const numId = typeof id === 'string' ? Number(id) : id;
      if (numId === 100) {
        return {
          payment_id: 100,
          payment_extra_ids: [101, 102],
          payment_status: 'finished',
          actually_paid: 1,
          pay_amount: 1,
          pay_currency: 'usdcbase',
          outcome_amount: 0.99,
          created_at: '2025-01-00T00:00:00Z',
        };
      }
      if (numId === 101) {
        return {
          payment_id: 101,
          payment_status: 'finished',
          outcome_amount: 5.0,
          actually_paid: 5,
          pay_amount: 5,
          pay_currency: 'usdcbase',
          created_at: '2025-01-02T00:00:00Z',
        };
      }
      return {
        payment_id: 102,
        payment_status: 'confirming',
        outcome_amount: 3.0,
        actually_paid: 3,
        pay_amount: 3,
        pay_currency: 'usdcbase',
        created_at: '2025-01-01T00:00:00Z',
      };
    });

    const result = await getDepositHistory(42, 1, 10);

    // finished: 5.0 * 1000 = 5000 buzz
    const finished = result.deposits.find((d) => d?.paymentId === 101);
    expect(finished?.buzzCredited).toBe(5000);

    // confirming: null (not yet credited)
    const confirming = result.deposits.find((d) => d?.paymentId === 102);
    expect(confirming?.buzzCredited).toBeNull();
  });

  it('includes fee data from CryptoDepositFee table', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: '100',
    });

    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValue({
      payment_id: 100,
      payment_status: 'finished',
      actually_paid: 10,
      pay_amount: 10,
      pay_currency: 'usdcbase',
      outcome_amount: 9.5,
      created_at: '2025-01-01T00:00:00Z',
      payment_extra_ids: undefined,
    });

    mockDbRead.cryptoDepositFee.findMany.mockResolvedValue([
      {
        paymentId: BigInt(100),
        depositFee: 0.25,
        serviceFee: 0.15,
        feeCurrency: 'usdcbase',
        paidFiat: 10.0,
        createdAt: new Date(),
      },
    ]);

    const result = await getDepositHistory(42, 1, 3);

    expect(result.deposits[0]).toMatchObject({
      paymentId: 100,
      depositFee: 0.25,
      serviceFee: 0.15,
      feeCurrency: 'usdcbase',
      paidFiat: 10.0,
    });
  });

  it('returns null fees when no fee record exists', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: '100',
    });

    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValue({
      payment_id: 100,
      payment_status: 'finished',
      actually_paid: 5,
      pay_amount: 5,
      pay_currency: 'usdcbase',
      outcome_amount: 4.95,
      created_at: '2025-01-01T00:00:00Z',
      payment_extra_ids: undefined,
    });

    mockDbRead.cryptoDepositFee.findMany.mockResolvedValue([]);

    const result = await getDepositHistory(42, 1, 3);

    expect(result.deposits[0]).toMatchObject({
      depositFee: null,
      serviceFee: null,
      feeCurrency: null,
      paidFiat: null,
    });
  });

  it('filters out null child payments', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      wallet: '0xAddr',
      smartAccount: '100',
    });

    mockNowpaymentsCaller.getPaymentStatus.mockImplementation(async (id: string | number) => {
      const numId = typeof id === 'string' ? Number(id) : id;
      if (numId === 100) {
        return {
          payment_id: 100,
          payment_extra_ids: [101, 102],
          payment_status: 'waiting',
          actually_paid: 0,
          pay_amount: 1,
          pay_currency: 'usdcbase',
          outcome_amount: 0,
          created_at: '2025-01-00T00:00:00Z',
        };
      }
      if (numId === 101) return null; // API failure for this child
      return {
        payment_id: 102,
        payment_status: 'finished',
        outcome_amount: 2.0,
        actually_paid: 2,
        pay_amount: 2,
        pay_currency: 'eth',
        created_at: '2025-01-01T00:00:00Z',
      };
    });

    const result = await getDepositHistory(42, 1, 10);
    expect(result.deposits).toHaveLength(1);
    expect(result.deposits[0]?.paymentId).toBe(102);
  });
});
