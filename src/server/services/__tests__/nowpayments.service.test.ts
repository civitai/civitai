import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';

// Use vi.hoisted so mocks are available inside vi.mock factories
const {
  mockDbRead,
  mockDbWrite,
  mockNowpaymentsCaller,
  mockGrantBuzzPurchase,
  mockGetTransactionByExternalId,
  mockGetMultipliersForUser,
  mockSignalClient,
  mockWithDistributedLock,
} = vi.hoisted(() => {
  const mockCryptoWallet = {
    findUnique: vi.fn(),
    create: vi.fn(),
  };

  return {
    mockDbRead: {
      cryptoWallet: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      cryptoDeposit: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    },
    mockDbWrite: {
      cryptoWallet: mockCryptoWallet,
      cryptoDeposit: { upsert: vi.fn().mockResolvedValue({}) },
    },
    mockNowpaymentsCaller: {
      createPayment: vi.fn(),
      getPaymentStatus: vi.fn(),
      getListPayments: vi.fn(),
      getMerchantCoins: vi.fn(),
      getFullCurrencies: vi.fn(),
      getMinimumPaymentAmount: vi.fn(),
    },
    mockGrantBuzzPurchase: vi.fn().mockResolvedValue('tx_123'),
    mockGetTransactionByExternalId: vi.fn().mockResolvedValue(null),
    mockGetMultipliersForUser: vi.fn().mockResolvedValue({ purchasesMultiplier: 1 }),
    mockSignalClient: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    mockWithDistributedLock: vi.fn(async (_opts: any, fn: () => Promise<any>) => fn()),
  };
});

// Mock modules
vi.mock('~/env/server', () => ({
  env: { NEXTAUTH_URL: 'https://civitai.com', LOGGING: '' },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
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
  getTransactionByExternalId: mockGetTransactionByExternalId,
  getMultipliersForUser: mockGetMultipliersForUser,
}));

vi.mock('~/utils/signal-client', () => ({
  signalClient: mockSignalClient,
}));

vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: mockWithDistributedLock,
}));

vi.mock('~/server/common/enums', () => ({
  SignalMessages: { CryptoDepositUpdate: 'crypto-deposit:update' },
  NotificationCategory: { Buzz: 'buzz' },
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
  getDepositAddress,
  processDeposit,
  getDepositHistory,
  reconcileDeposits,
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
    pay_address: '0xTestAddr',
    ...overrides,
  };
}

// ─── processDeposit ──────────────────────────────────────────────────────────

describe('processDeposit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: wallet lookup returns a chain
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({ chain: 'evm' });
  });

  it('parses userId from order_id and sends signal', async () => {
    const event = makeWebhookEvent({ payment_status: 'confirming' });
    const result = await processDeposit(12345, 'confirming', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 0, transactionId: undefined });
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

  it('grants buzz on partially_paid status', async () => {
    const event = makeWebhookEvent({ payment_status: 'partially_paid', outcome_amount: 3.0 });
    const result = await processDeposit(12345, 'partially_paid', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 3000, transactionId: 'tx_123' });
    expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 3000 })
    );
  });

  it('does not grant buzz on confirming status', async () => {
    const event = makeWebhookEvent({ payment_status: 'confirming', outcome_amount: 5.0 });
    const result = await processDeposit(12345, 'confirming', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 0, transactionId: undefined });
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

    expect(result).toEqual({ userId: 42, buzzAmount: 0, transactionId: undefined });
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('handles null outcome_amount on finished', async () => {
    const event = makeWebhookEvent({ outcome_amount: null });
    const result = await processDeposit(12345, 'finished', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 0, transactionId: undefined });
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

  it('upserts CryptoDeposit record on every webhook status', async () => {
    const event = makeWebhookEvent({ payment_status: 'confirming' });
    await processDeposit(12345, 'confirming', event);

    expect(mockDbWrite.cryptoDeposit.upsert).toHaveBeenCalledWith({
      where: { paymentId: BigInt(12345) },
      create: expect.objectContaining({
        paymentId: BigInt(12345),
        userId: 42,
        status: 'confirming',
        payCurrency: 'btc',
        chain: 'evm',
      }),
      update: expect.objectContaining({
        status: 'confirming',
        payCurrency: 'btc',
      }),
    });
  });

  it('stores fee data in CryptoDeposit on finished status', async () => {
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

    expect(mockDbWrite.cryptoDeposit.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          depositFee: 0.25,
          serviceFee: 0.15,
          feeCurrency: 'usdcbase',
          paidFiat: 10.0,
        }),
      })
    );
  });

  it('handles missing fee object gracefully', async () => {
    const event = makeWebhookEvent({ outcome_amount: 5.0, fee: null });
    await processDeposit(12345, 'finished', event);

    expect(mockDbWrite.cryptoDeposit.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          depositFee: null,
          serviceFee: null,
          feeCurrency: null,
        }),
      })
    );
  });
});

// ─── getDepositAddress ───────────────────────────────────────────────────────

describe('getDepositAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing wallet without calling NowPayments', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      chain: 'evm',
      wallet: '0xExistingAddress',
      smartAccount: '12345',
    });

    const result = await getDepositAddress(42);

    expect(result).toEqual({ address: '0xExistingAddress', paymentId: 12345, chain: 'evm' });
    expect(mockNowpaymentsCaller.createPayment).not.toHaveBeenCalled();
  });

  it('creates new wallet via NowPayments when none exists', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue(null);
    mockNowpaymentsCaller.createPayment.mockResolvedValue({
      pay_address: '0xNewAddress',
      payment_id: 67890,
    });

    const result = await getDepositAddress(42);

    expect(result).toEqual({ address: '0xNewAddress', paymentId: 67890, chain: 'evm' });
    expect(mockNowpaymentsCaller.createPayment).toHaveBeenCalledWith({
      price_amount: 20,
      price_currency: 'usd',
      pay_currency: 'usdcbase',
      order_id: 'user:42',
      ipn_callback_url: 'https://civitai.com/api/webhooks/nowpayments',
    });
    expect(mockDbWrite.cryptoWallet.create).toHaveBeenCalledWith({
      data: {
        userId: 42,
        chain: 'evm',
        wallet: '0xNewAddress',
        smartAccount: '67890',
        payCurrency: 'usdcbase',
      },
    });
  });

  it('uses distributed lock for creation', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue(null);
    mockNowpaymentsCaller.createPayment.mockResolvedValue({
      pay_address: '0xNewAddress',
      payment_id: 67890,
    });

    await getDepositAddress(42);

    expect(mockWithDistributedLock).toHaveBeenCalledWith(
      { key: 'crypto-deposit:create:42:evm' },
      expect.any(Function)
    );
  });

  it('throws when NowPayments returns null', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue(null);
    mockNowpaymentsCaller.createPayment.mockResolvedValue(null);

    await expect(getDepositAddress(42)).rejects.toThrow(
      'Failed to create deposit address via NowPayments'
    );
  });

  it('handles null smartAccount on existing wallet', async () => {
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({
      userId: 42,
      chain: 'evm',
      wallet: '0xExistingAddress',
      smartAccount: null,
    });

    // wallet exists but smartAccount is null — still returns the address
    const result = await getDepositAddress(42);
    expect(result).toEqual({ address: '0xExistingAddress', paymentId: null, chain: 'evm' });
  });
});

// ─── getDepositHistory ───────────────────────────────────────────────────────

describe('getDepositHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when no deposits exist', async () => {
    mockDbRead.cryptoDeposit.findMany.mockResolvedValue([]);
    mockDbRead.cryptoDeposit.count.mockResolvedValue(0);

    const result = await getDepositHistory(42);
    expect(result).toEqual({ deposits: [], total: 0 });
  });

  it('returns deposits ordered by createdAt desc with pagination', async () => {
    const now = new Date();
    const yesterday = new Date(Date.now() - 86400000);

    mockDbRead.cryptoDeposit.findMany.mockResolvedValue([
      {
        paymentId: BigInt(102),
        userId: 42,
        status: 'finished',
        payCurrency: 'usdcbase',
        payAmount: 10,
        outcomeAmount: 9.5,
        buzzCredited: 9500,
        depositFee: 0.25,
        serviceFee: 0.15,
        feeCurrency: 'usdcbase',
        paidFiat: 10.0,
        chain: 'evm',
        createdAt: now,
        updatedAt: now,
      },
      {
        paymentId: BigInt(101),
        userId: 42,
        status: 'confirming',
        payCurrency: 'btc',
        payAmount: 0.0005,
        outcomeAmount: null,
        buzzCredited: null,
        depositFee: null,
        serviceFee: null,
        feeCurrency: null,
        paidFiat: null,
        chain: 'btc',
        createdAt: yesterday,
        updatedAt: yesterday,
      },
    ]);
    mockDbRead.cryptoDeposit.count.mockResolvedValue(2);

    const result = await getDepositHistory(42, 1, 3);

    expect(result.total).toBe(2);
    expect(result.deposits).toHaveLength(2);
    expect(result.deposits[0]?.paymentId).toBe(102);
    expect(result.deposits[0]?.buzzCredited).toBe(9500);
    expect(result.deposits[0]?.chain).toBe('evm');
    expect(result.deposits[1]?.paymentId).toBe(101);
    expect(result.deposits[1]?.buzzCredited).toBeNull();
    expect(result.deposits[1]?.chain).toBe('btc');
  });

  it('clamps page and perPage to safe ranges', async () => {
    mockDbRead.cryptoDeposit.findMany.mockResolvedValue([]);
    mockDbRead.cryptoDeposit.count.mockResolvedValue(0);

    await getDepositHistory(42, -1, 100);

    expect(mockDbRead.cryptoDeposit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0, // page clamped to 1 → skip 0
        take: 25, // perPage clamped to MAX_PER_PAGE
      })
    );
  });
});

// ─── reconcileDeposits ────────────────────────────────────────────────────────

// Helper to build a NP payment response (as returned by the list API)
function makePayment(
  overrides: Partial<NOWPayments.CreatePaymentResponse> = {}
): NOWPayments.CreatePaymentResponse {
  return {
    payment_id: 12345,
    payment_status: 'finished',
    pay_address: '0xTestAddr',
    price_amount: 10,
    price_currency: 'usd',
    pay_amount: 10,
    pay_currency: 'btc',
    order_id: 'user:42',
    created_at: new Date('2026-03-15'),
    updated_at: new Date('2026-03-15'),
    outcome_amount: 5.0,
    actually_paid: 10,
    parent_payment_id: null,
    ...overrides,
  } as NOWPayments.CreatePaymentResponse;
}

describe('reconcileDeposits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({ chain: 'evm' });
    mockGetTransactionByExternalId.mockResolvedValue(null);
  });

  it('processes completed payments that have not been granted buzz', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [makePayment({ payment_id: 111, outcome_amount: 5.0 })],
    });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.totalPayments).toBe(1);
    expect(result.completedPayments).toBe(1);
    expect(result.newlyProcessed).toBe(1);
    expect(result.alreadyProcessed).toBe(0);
    expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionId: 'np-deposit-111',
        amount: 5000,
      })
    );
  });

  it('skips payments already granted buzz', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [makePayment({ payment_id: 222 })],
    });
    mockGetTransactionByExternalId.mockResolvedValueOnce({ transactionId: 'existing_tx' });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.alreadyProcessed).toBe(1);
    expect(result.newlyProcessed).toBe(0);
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('skips payments with invalid order_id', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [makePayment({ payment_id: 333, order_id: 'bad-format' })],
    });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.skipped).toBe(1);
    expect(result.newlyProcessed).toBe(0);
    expect(result.details[0]).toMatchObject({
      action: 'skipped',
      error: expect.stringContaining('Invalid order_id'),
    });
  });

  it('filters out non-completed payment statuses', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [
        makePayment({ payment_id: 444, payment_status: 'waiting' }),
        makePayment({ payment_id: 445, payment_status: 'confirming' }),
        makePayment({ payment_id: 446, payment_status: 'finished', outcome_amount: 2.0 }),
      ],
    });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.totalPayments).toBe(3);
    expect(result.completedPayments).toBe(1);
    expect(result.newlyProcessed).toBe(1);
    expect(mockGrantBuzzPurchase).toHaveBeenCalledTimes(1);
  });

  it('handles partially_paid status', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [makePayment({ payment_id: 555, payment_status: 'partially_paid', outcome_amount: 3.0 })],
    });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.completedPayments).toBe(1);
    expect(result.newlyProcessed).toBe(1);
  });

  it('paginates through multiple pages', async () => {
    // First page: 100 items (full page → triggers next page fetch)
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makePayment({ payment_id: 1000 + i, outcome_amount: 1.0 })
    );
    // Second page: 2 items (< PAGE_SIZE → last page)
    const page2 = [
      makePayment({ payment_id: 2000, outcome_amount: 1.0 }),
      makePayment({ payment_id: 2001, outcome_amount: 1.0 }),
    ];

    mockNowpaymentsCaller.getListPayments
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(mockNowpaymentsCaller.getListPayments).toHaveBeenCalledTimes(2);
    expect(result.totalPayments).toBe(102);
    expect(result.newlyProcessed).toBe(102);
  });

  it('returns empty results when no payments found', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({ data: [] });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.totalPayments).toBe(0);
    expect(result.completedPayments).toBe(0);
    expect(result.newlyProcessed).toBe(0);
    expect(result.details).toEqual([]);
  });

  it('handles null response from NP API gracefully', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce(null);

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.totalPayments).toBe(0);
  });

  it('records failed deposits without stopping the batch', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [
        makePayment({ payment_id: 666, outcome_amount: 5.0 }),
        makePayment({ payment_id: 667, outcome_amount: 2.0 }),
      ],
    });
    // First call (payment 666) will fail at grantBuzzPurchase
    mockGrantBuzzPurchase
      .mockRejectedValueOnce(new Error('Buzz API error'))
      .mockResolvedValueOnce('tx_ok');

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.failed).toBe(1);
    expect(result.newlyProcessed).toBe(1);
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paymentId: 666, action: 'failed' }),
        expect.objectContaining({ paymentId: 667, action: 'processed' }),
      ])
    );
  });

  it('is idempotent: second run shows all as already_processed', async () => {
    const payments = [
      makePayment({ payment_id: 777, outcome_amount: 5.0 }),
      makePayment({ payment_id: 778, outcome_amount: 3.0 }),
    ];

    // First run: nothing exists yet
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({ data: payments });
    mockGetTransactionByExternalId.mockResolvedValue(null);
    const firstRun = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
    expect(firstRun.newlyProcessed).toBe(2);

    // Second run: all transactions now exist
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({ data: payments });
    mockGetTransactionByExternalId.mockResolvedValue({ transactionId: 'existing' });
    vi.clearAllMocks();
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({ data: payments });
    mockGetTransactionByExternalId.mockResolvedValue({ transactionId: 'existing' });

    const secondRun = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
    expect(secondRun.alreadyProcessed).toBe(2);
    expect(secondRun.newlyProcessed).toBe(0);
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('passes correct date params to NP API', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({ data: [] });

    await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-23' });

    expect(mockNowpaymentsCaller.getListPayments).toHaveBeenCalledWith({
      limit: 100,
      page: 1,
      dateFrom: '2026-03-01',
      dateTo: '2026-03-23',
      sortBy: 'created_at',
      orderBy: 'asc',
    });
  });

  // ─── paymentIds mode ──────────────────────────────────────────────────────

  it('fetches individual payments by ID when paymentIds provided', async () => {
    mockNowpaymentsCaller.getPaymentStatus
      .mockResolvedValueOnce(makePayment({ payment_id: 111, outcome_amount: 5.0 }))
      .mockResolvedValueOnce(makePayment({ payment_id: 222, outcome_amount: 3.0 }));

    const result = await reconcileDeposits({ paymentIds: [111, 222] });

    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledTimes(2);
    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledWith(111);
    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledWith(222);
    expect(mockNowpaymentsCaller.getListPayments).not.toHaveBeenCalled();
    expect(result.totalPayments).toBe(2);
    expect(result.newlyProcessed).toBe(2);
  });

  it('skips not-found payments when fetching by ID', async () => {
    mockNowpaymentsCaller.getPaymentStatus
      .mockResolvedValueOnce(null) // payment not found
      .mockResolvedValueOnce(makePayment({ payment_id: 222, outcome_amount: 3.0 }));

    const result = await reconcileDeposits({ paymentIds: [999, 222] });

    expect(result.totalPayments).toBe(1);
    expect(result.newlyProcessed).toBe(1);
  });

  it('processes non-finished payments fetched by ID correctly', async () => {
    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce(
      makePayment({ payment_id: 333, payment_status: 'waiting', outcome_amount: 5.0 })
    );

    const result = await reconcileDeposits({ paymentIds: [333] });

    expect(result.totalPayments).toBe(1);
    expect(result.completedPayments).toBe(0);
    expect(result.newlyProcessed).toBe(0);
  });

  it('prefers paymentIds over dateFrom/dateTo when both provided', async () => {
    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce(
      makePayment({ payment_id: 444, outcome_amount: 2.0 })
    );

    await reconcileDeposits({
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
      paymentIds: [444],
    });

    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledWith(444);
    expect(mockNowpaymentsCaller.getListPayments).not.toHaveBeenCalled();
  });
});
