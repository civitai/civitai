import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import type * as ManualCredit from '~/server/services/nowpayments-manual-credit';
import type * as DbHelpers from '~/server/db/db-helpers';

// Use vi.hoisted so mocks are available inside vi.mock factories
const {
  mockNowpaymentsCaller,
  mockGrantBuzzPurchase,
  mockGetTransactionByExternalId,
  mockGetMultipliersForUser,
  mockSignalClient,
  mockWithDistributedLock,
  mockKvGet,
} = vi.hoisted(() => {
  return {
    mockKvGet: vi.fn(async (_key: string, defaultValue?: unknown) => defaultValue),
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

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  dbKV: { get: mockKvGet },
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

// The hand-grant scan runs against a fake ledger in nowpayments-credit.service.test.ts.
vi.mock('~/server/services/nowpayments-manual-credit', async (importOriginal) => ({
  ...(await importOriginal<typeof ManualCredit>()),
  findHandGrantsForDeposit: vi.fn(async () => ({ covering: [], possible: [], overflowed: [] })),
}));

vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: mockWithDistributedLock,
}));

vi.mock('~/server/common/enums', () => ({
  SignalMessages: { CryptoDepositUpdate: 'crypto-deposit:update' },
  NotificationCategory: { Buzz: 'buzz' },
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
  reconcileUserDeposits,
  reprocessDeposit,
  retryFailedDeposits,
  watchOpenDeposits,
  getOpenDepositReport,
  recordUnverifiedDeposit,
} from '~/server/services/nowpayments.service';
import { findHandGrantsForDeposit } from '~/server/services/nowpayments-manual-credit';

// The two clients stay split, exactly as the fixture they replace had them: the old `mockDbRead`
// carried only read methods and `mockDbWrite` only writes, so a mis-routed call used to die on a
// missing method. It now lands on a vivified node instead, which is why the write returns below
// are restated rather than left to the canonical defaults — a service that reads what a write
// returned must keep getting a value.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// Reads are left to the canonical defaults: findUnique → null, findMany → [], count → 0, which
// is what the old fixture spelled out by hand. Writes have no canonical default.
mockDbWrite.cryptoDeposit.upsert.mockResolvedValue({});
mockDbWrite.cryptoDeposit.update.mockResolvedValue({});
mockDbWrite.cryptoDeposit.updateMany.mockResolvedValue({ count: 1 });

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

/**
 * Runs processDeposit against a row holding `existing` and returns the row's status afterwards,
 * applying the conditional status write the way Postgres would.
 */
async function statusAfter(
  existing: Record<string, unknown> | null,
  webhookStatus: string,
  event: NOWPayments.WebhookEvent
) {
  let status = existing?.status as string | undefined;
  mockDbWrite.cryptoDeposit.findUnique.mockResolvedValue(existing);
  mockDbWrite.cryptoDeposit.upsert.mockImplementationOnce(async ({ create }: any) => {
    status ??= create.status;
    return {};
  });
  mockDbWrite.cryptoDeposit.updateMany.mockImplementationOnce(async ({ where, data }: any) => {
    if (where.status.notIn.includes(status)) return { count: 0 };
    status = data.status;
    return { count: 1 };
  });
  await processDeposit(12345, webhookStatus, event);
  return status;
}

// ─── processDeposit ──────────────────────────────────────────────────────────

describe('processDeposit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: wallet lookup returns a chain
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({ chain: 'evm' });
    // Default: no existing CryptoDeposit record
    mockDbRead.cryptoDeposit.findUnique.mockResolvedValue(null);
    // statusAfter queues one-shot replies; reset so none outlive a test that threw early.
    mockDbWrite.cryptoDeposit.findUnique.mockReset().mockResolvedValue(null);
    mockDbWrite.cryptoDeposit.upsert.mockReset().mockResolvedValue({});
    mockDbWrite.cryptoDeposit.updateMany.mockReset().mockResolvedValue({ count: 1 });
    // clearAllMocks keeps unconsumed mockResolvedValueOnce queues; reset so none leak across tests.
    mockNowpaymentsCaller.getPaymentStatus
      .mockReset()
      .mockResolvedValue({ payin_hash: '0xdefault' });
    mockGetTransactionByExternalId.mockReset().mockResolvedValue(null);
    mockGetMultipliersForUser.mockReset().mockResolvedValue({ purchasesMultiplier: 1 });
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
    expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(expect.objectContaining({ amount: 3000 }));
  });

  it('does not grant buzz on confirming status', async () => {
    const event = makeWebhookEvent({ payment_status: 'confirming', outcome_amount: 5.0 });
    const result = await processDeposit(12345, 'confirming', event);

    expect(result).toEqual({ userId: 42, buzzAmount: 0, transactionId: undefined });
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('records failed status and grants zero buzz', async () => {
    const event = makeWebhookEvent({ payment_status: 'failed', outcome_amount: 5.0 });
    const status = await statusAfter({ status: 'confirming', buzzCredited: null }, 'failed', event);

    expect(status).toBe('failed');
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'NowPayments reported deposit failed', userId: 42 })
    );
  });

  it('does not overwrite buzz_failed status with failed (keeps it in the retry sweep)', async () => {
    const event = makeWebhookEvent({ payment_status: 'failed', outcome_amount: 5.0 });

    expect(await statusAfter({ status: 'buzz_failed', buzzCredited: null }, 'failed', event)).toBe(
      'buzz_failed'
    );
  });

  it('preserves recorded amounts when a failed event with null amounts lands on a finished row', async () => {
    const event = makeWebhookEvent({
      payment_status: 'failed',
      actually_paid: null,
      outcome_amount: null,
    });
    const existing = { status: 'finished', payAmount: 10, outcomeAmount: 9.5, buzzCredited: 9500 };

    // Status stays finished (immutable) and the amounts are not nulled out.
    expect(await statusAfter(existing, 'failed', event)).toBe('finished');
    const upsertCall = mockDbWrite.cryptoDeposit.upsert.mock.calls[0][0];
    expect(upsertCall.update).toMatchObject({ payAmount: 10, outcomeAmount: 9.5 });
  });

  it('advances failed to finished when a completed webhook arrives afterward', async () => {
    const event = makeWebhookEvent({ outcome_amount: 5.0 });

    expect(await statusAfter({ status: 'failed', buzzCredited: null }, 'finished', event)).toBe(
      'finished'
    );
    expect(mockGrantBuzzPurchase).toHaveBeenCalled();
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

  // A paid payment without an amount is left to the retry sweep, not closed as finished with
  // nothing credited (which nothing would ever revisit).
  it.each([0, null])(
    'leaves a paid deposit with outcome_amount %s to the retry sweep',
    async (amount) => {
      const event = makeWebhookEvent({ outcome_amount: amount });
      const result = await processDeposit(12345, 'finished', event);

      expect(result).toEqual({ userId: 42, buzzAmount: 0, transactionId: undefined });
      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      expect(mockDbWrite.cryptoDeposit.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ status: 'buzz_failed' }) })
      );
      expect(mockSignalClient.send).not.toHaveBeenCalled();
    }
  );

  it.each([null, 'invalid-format', 'user:abc'])(
    'refuses order_id %s and records nothing',
    async (order_id) => {
      const event = makeWebhookEvent({ order_id });
      await expect(processDeposit(12345, 'finished', event)).rejects.toThrow('Invalid order_id');
      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      expect(mockDbWrite.cryptoDeposit.upsert).not.toHaveBeenCalled();
    }
  );

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
      update: expect.objectContaining({ payCurrency: 'btc' }),
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

  it('upserts buzz_failed status when grantBuzzPurchase throws', async () => {
    mockGrantBuzzPurchase.mockRejectedValueOnce(new Error('Buzz API down'));
    const event = makeWebhookEvent({ outcome_amount: 5.0 });
    const result = await processDeposit(12345, 'finished', event);

    // Should not throw — error is caught internally
    expect(result.buzzAmount).toBe(5000);
    expect(result.transactionId).toBeUndefined();
    expect(mockDbWrite.cryptoDeposit.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'buzz_failed',
          buzzCredited: null,
        }),
      })
    );
  });

  it('treats 409 conflict as success (already granted by another path)', async () => {
    mockGrantBuzzPurchase.mockRejectedValueOnce(
      new Error('There is a conflict with the transaction')
    );
    const event = makeWebhookEvent({ outcome_amount: 5.0 });
    const result = await processDeposit(12345, 'finished', event);

    expect(result.transactionId).toBe('already_granted');
    expect(mockDbWrite.cryptoDeposit.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'finished',
        }),
      })
    );
  });

  it('does not overwrite finished status with confirming', async () => {
    const event = makeWebhookEvent({ payment_status: 'confirming' });

    expect(await statusAfter({ status: 'finished', buzzCredited: 5000 }, 'confirming', event)).toBe(
      'finished'
    );
  });

  it('does not overwrite finished status with buzz_failed', async () => {
    mockGrantBuzzPurchase.mockRejectedValueOnce(new Error('Buzz API down'));
    const event = makeWebhookEvent({ outcome_amount: 5.0 });

    expect(await statusAfter({ status: 'finished', buzzCredited: 5000 }, 'finished', event)).toBe(
      'finished'
    );
  });

  it('allows buzz_failed to be overwritten by finished on successful retry', async () => {
    const event = makeWebhookEvent({ outcome_amount: 5.0 });

    expect(
      await statusAfter({ status: 'buzz_failed', buzzCredited: null }, 'finished', event)
    ).toBe('finished');
  });

  describe('deposit already credited by hand under its payin hash', () => {
    const HASH = '0xAbC123';
    const manualTx = { transactionId: 'manual_tx' };

    beforeEach(() => {
      mockGetTransactionByExternalId.mockImplementation(async (id: string) =>
        id === 'np-payin-0xabc123' ? manualTx : null
      );
    });

    it('looks up the payin hash for an IPN event and skips the grant', async () => {
      mockGetMultipliersForUser.mockResolvedValueOnce({ purchasesMultiplier: 1.5 });
      mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce({ payin_hash: HASH });
      const result = await processDeposit(
        12345,
        'finished',
        makeWebhookEvent({ outcome_amount: 5 })
      );

      expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledWith(12345);
      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      expect(result.transactionId).toBe('already_granted');
      const upsertCall = mockDbWrite.cryptoDeposit.upsert.mock.calls[0]?.[0];
      expect(upsertCall?.create).toMatchObject({
        status: 'finished',
        buzzCredited: 5000,
        bonusBuzz: null,
        multiplier: null,
      });
    });

    it('uses the payin hash carried on a status-built event without a lookup', async () => {
      const event = makeWebhookEvent({ outcome_amount: 5, payin_hash: HASH });
      const result = await processDeposit(12345, 'finished', event);

      expect(mockNowpaymentsCaller.getPaymentStatus).not.toHaveBeenCalled();
      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      expect(result.transactionId).toBe('already_granted');
    });

    it('grants normally when a different deposit was credited by hand', async () => {
      mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce({ payin_hash: '0xother' });
      const result = await processDeposit(
        12345,
        'finished',
        makeWebhookEvent({ outcome_amount: 5 })
      );

      expect(mockGetTransactionByExternalId).toHaveBeenCalledWith('np-payin-0xother');
      expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
        expect.objectContaining({ externalTransactionId: 'np-deposit-12345', amount: 5000 })
      );
      expect(result.transactionId).toBe('tx_123');
    });

    it('does not trust a null payin hash on the event and looks it up', async () => {
      mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce({ payin_hash: HASH });
      const event = makeWebhookEvent({ outcome_amount: 5, payin_hash: null });
      const result = await processDeposit(12345, 'finished', event);

      expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledWith(12345);
      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      expect(result.transactionId).toBe('already_granted');
    });

    it('grants without a ledger lookup when NowPayments reports no payin hash', async () => {
      mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce({ payin_hash: null });
      const result = await processDeposit(
        12345,
        'finished',
        makeWebhookEvent({ outcome_amount: 5 })
      );

      expect(mockGetTransactionByExternalId).not.toHaveBeenCalledWith(
        expect.stringMatching(/^np-payin-/)
      );
      expect(result.transactionId).toBe('tx_123');
    });

    it('does not grant when the payin hash cannot be resolved, marking it buzz_failed', async () => {
      mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce(null);
      const result = await processDeposit(
        12345,
        'finished',
        makeWebhookEvent({ outcome_amount: 5 })
      );

      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      expect(result.transactionId).toBeUndefined();
      const upsertCall = mockDbWrite.cryptoDeposit.upsert.mock.calls[0]?.[0];
      expect(upsertCall?.create).toMatchObject({ status: 'buzz_failed', buzzCredited: null });
    });

    it('does not grant when the ledger lookup fails', async () => {
      mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce({ payin_hash: '0xother' });
      mockGetTransactionByExternalId.mockRejectedValueOnce(new Error('Buzz API down'));
      await processDeposit(12345, 'finished', makeWebhookEvent({ outcome_amount: 5 }));

      expect(mockGetTransactionByExternalId).toHaveBeenCalledWith('np-payin-0xother');
      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      const upsertCall = mockDbWrite.cryptoDeposit.upsert.mock.calls[0]?.[0];
      expect(upsertCall?.create).toMatchObject({ status: 'buzz_failed' });
    });
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
    payin_hash: '0xpayin',
    ...overrides,
  } as NOWPayments.CreatePaymentResponse;
}

describe('reconcileDeposits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNowpaymentsCaller.getPaymentStatus
      .mockReset()
      .mockRejectedValue(new Error('unexpected NowPayments status lookup'));
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({ chain: 'evm' });
    mockDbRead.cryptoDeposit.findUnique.mockResolvedValue(null);
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
      data: [
        makePayment({ payment_id: 555, payment_status: 'partially_paid', outcome_amount: 3.0 }),
      ],
    });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.completedPayments).toBe(1);
    expect(result.newlyProcessed).toBe(1);
  });

  it('paginates through multiple pages', async () => {
    // First page: 500 items (full page → triggers next page fetch)
    const page1 = Array.from({ length: 500 }, (_, i) =>
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
    expect(result.totalPayments).toBe(502);
    expect(result.newlyProcessed).toBe(502);
  });

  it('returns empty results when no payments found', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({ data: [] });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.totalPayments).toBe(0);
    expect(result.completedPayments).toBe(0);
    expect(result.newlyProcessed).toBe(0);
    expect(result.details).toEqual([]);
  });

  it('throws on null response from NP API', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce(null);

    await expect(
      reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' })
    ).rejects.toThrow('NP API returned error');
  });

  it('processes deposits with buzz_failed status when grantBuzzPurchase throws', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [
        makePayment({ payment_id: 666, outcome_amount: 5.0 }),
        makePayment({ payment_id: 667, outcome_amount: 2.0 }),
      ],
    });
    // First call (payment 666) will fail at grantBuzzPurchase
    // processDeposit now catches this internally and upserts as buzz_failed
    mockGrantBuzzPurchase
      .mockRejectedValueOnce(new Error('Buzz API error'))
      .mockResolvedValueOnce('tx_ok');

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    // Both are "processed" at the reconciliation level — buzz_failed is handled inside processDeposit
    expect(result.newlyProcessed).toBe(2);
    expect(result.failed).toBe(0);
    // The first deposit should have been upserted with buzz_failed status in CryptoDeposit
    expect(mockDbWrite.cryptoDeposit.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          paymentId: BigInt(666),
          status: 'buzz_failed',
        }),
      })
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
      limit: 500,
      page: 0,
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

// ─── payin_hash passthrough from status-built events ────────────────────────

describe('status-built events carry payin_hash into the manual-credit guard', () => {
  const PAYIN = '0xPASS';

  beforeEach(() => {
    vi.clearAllMocks();
    mockNowpaymentsCaller.getPaymentStatus
      .mockReset()
      .mockRejectedValue(new Error('unexpected NowPayments status lookup'));
    mockDbRead.cryptoWallet.findUnique.mockResolvedValue({ chain: 'evm' });
    mockDbRead.cryptoDeposit.findUnique.mockResolvedValue(null);
    mockGetTransactionByExternalId.mockImplementation(async (id: string) =>
      id === 'np-payin-0xpass' ? { transactionId: 'manual_tx' } : null
    );
  });

  it('reprocessDeposit', async () => {
    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce(
      makePayment({ payment_id: 12345, payin_hash: PAYIN })
    );

    await reprocessDeposit(12345);

    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledTimes(1);
    expect(mockGetTransactionByExternalId).toHaveBeenCalledWith('np-payin-0xpass');
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('retryFailedDeposits', async () => {
    mockDbRead.cryptoDeposit.findMany.mockResolvedValueOnce([
      { paymentId: BigInt(12345), retryCount: 0 },
    ]);
    mockNowpaymentsCaller.getPaymentStatus.mockResolvedValueOnce(
      makePayment({ payment_id: 12345, payin_hash: PAYIN })
    );

    await retryFailedDeposits();

    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledTimes(1);
    expect(mockGetTransactionByExternalId).toHaveBeenCalledWith('np-payin-0xpass');
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('reconcileUserDeposits', async () => {
    mockDbRead.cryptoWallet.findMany.mockResolvedValueOnce([{ smartAccount: '999' }]);
    mockNowpaymentsCaller.getPaymentStatus
      .mockResolvedValueOnce(
        makePayment({ payment_id: 999, payment_status: 'waiting', payment_extra_ids: [12345] })
      )
      .mockResolvedValueOnce(makePayment({ payment_id: 12345, payin_hash: PAYIN }));

    await reconcileUserDeposits(42);

    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledTimes(2);
    expect(mockGetTransactionByExternalId).toHaveBeenCalledWith('np-payin-0xpass');
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });
});

describe('reconcileUserDeposits', () => {
  beforeEach(resetDepositMocks);

  it('bounds concurrent child lookups', async () => {
    const childIds = Array.from({ length: 20 }, (_, i) => 1000 + i);
    mockDbRead.cryptoWallet.findMany.mockResolvedValueOnce([{ smartAccount: '999' }]);
    let inFlight = 0;
    let peak = 0;
    mockNowpaymentsCaller.getPaymentStatus.mockImplementation(async (id: number) => {
      if (id === 999) return makePayment({ payment_id: 999, payment_extra_ids: childIds });
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return makePayment({ payment_id: id, payment_status: 'waiting' });
    });

    await reconcileUserDeposits(42);

    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledTimes(childIds.length + 1);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

// ─── Open deposits ───────────────────────────────────────────────────────────

/** clearAllMocks keeps unconsumed one-shot replies, so reset every mock these tests queue. */
function resetDepositMocks() {
  vi.clearAllMocks();
  mockDbRead.cryptoWallet.findUnique.mockResolvedValue({ chain: 'evm' });
  mockDbRead.cryptoDeposit.findUnique.mockReset().mockResolvedValue(null);
  mockDbRead.cryptoDeposit.findMany.mockReset().mockResolvedValue([]);
  mockDbRead.cryptoDeposit.count.mockReset().mockResolvedValue(0);
  mockDbWrite.cryptoDeposit.findUnique.mockReset().mockResolvedValue(null);
  mockDbWrite.cryptoDeposit.upsert.mockReset().mockResolvedValue({});
  mockDbWrite.cryptoDeposit.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockNowpaymentsCaller.getListPayments.mockReset();
  mockNowpaymentsCaller.getPaymentStatus.mockReset().mockResolvedValue({ payin_hash: '0xdefault' });
  mockGetTransactionByExternalId.mockReset().mockResolvedValue(null);
  mockGetMultipliersForUser.mockReset().mockResolvedValue({ purchasesMultiplier: 1 });
  mockGrantBuzzPurchase.mockReset().mockResolvedValue('tx_123');
}

type DepositRow = Record<string, unknown>;
/** Applies the subset of a Prisma where-clause the deposit queries use: equality, in, gt and OR. */
const matchesWhere = (row: DepositRow, where: Record<string, any>): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Record<string, any>[]).some((w) => matchesWhere(row, w));
    if (cond && typeof cond === 'object' && 'in' in cond) return cond.in.includes(row[key]);
    if (cond && typeof cond === 'object' && 'gt' in cond) return (row[key] as number) > cond.gt;
    return (row[key] ?? null) === cond;
  });

/** Serves cryptoDeposit findMany/count from a fake table, so a wrong where-clause changes results. */
function serveDepositTable(table: () => DepositRow[]) {
  mockDbRead.cryptoDeposit.findMany.mockImplementation(async ({ where }: any) =>
    table()
      .filter((r) => matchesWhere(r, where))
      .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
  );
  mockDbRead.cryptoDeposit.count.mockImplementation(
    async ({ where }: any) => table().filter((r) => matchesWhere(r, where)).length
  );
}

describe('recordUnverifiedDeposit', () => {
  beforeEach(resetDepositMocks);

  it.each(['waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'failed', 'expired'])(
    'hands a %s row to the retry sweep when a paid IPN cannot be verified',
    async (status) => {
      let rowStatus = status;
      mockDbWrite.cryptoDeposit.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (!where.status.in.includes(rowStatus)) return { count: 0 };
        rowStatus = data.status;
        return { count: 1 };
      });

      await recordUnverifiedDeposit(makeWebhookEvent({ payment_status: 'finished' }));

      expect(rowStatus).toBe('buzz_failed');
      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
    }
  );

  it.each(['finished', 'held', 'unverified', 'refunded', 'unverified_exhausted'])(
    'leaves a %s row where it is when a paid IPN cannot be verified',
    async (status) => {
      let rowStatus = status;
      mockDbWrite.cryptoDeposit.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (!where.status.in.includes(rowStatus)) return { count: 0 };
        rowStatus = data.status;
        return { count: 1 };
      });

      await recordUnverifiedDeposit(makeWebhookEvent({ payment_status: 'finished' }));

      expect(rowStatus).toBe(status);
    }
  );
});

const staffTipCitingPayment = {
  covering: [
    {
      ref: 'tip-1',
      why: 'cites the payment id',
      strength: 'hard',
      fromStaff: true,
    } as unknown as ManualCredit.ManualCreditMatch,
  ],
  possible: [],
  overflowed: [],
};

describe('in-flight and closing statuses on a deposit row', () => {
  beforeEach(resetDepositMocks);

  it('records a confirmed payment without crediting it', async () => {
    const status = await statusAfter(
      null,
      'confirmed',
      makeWebhookEvent({ payment_status: 'confirmed', outcome_amount: undefined })
    );

    expect(status).toBe('confirmed');
    expect(mockDbWrite.cryptoDeposit.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'confirmed', payAmount: 10, userId: 42 }),
      })
    );
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it.each(['expired', 'refunded'])('%s closes a confirming row', async (closing) => {
    const status = await statusAfter(
      { status: 'confirming' },
      closing,
      makeWebhookEvent({ payment_status: closing })
    );
    expect(status).toBe(closing);
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });

  it.each(['expired', 'refunded', 'failed'])(
    'a finished payment NOWPayments first marked %s is still credited',
    async (closed) => {
      const status = await statusAfter({ status: closed }, 'finished', makeWebhookEvent());
      expect(status).toBe('finished');
      expect(mockGrantBuzzPurchase).toHaveBeenCalledTimes(1);
    }
  );

  it('a late finish on an expired row is held when a staff hand grant cites it', async () => {
    vi.mocked(findHandGrantsForDeposit).mockResolvedValueOnce(staffTipCitingPayment);

    const status = await statusAfter({ status: 'expired' }, 'finished', makeWebhookEvent());

    expect(status).toBe('held');
    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
  });
});

describe('reconcileDeposits with in-flight payments', () => {
  beforeEach(resetDepositMocks);

  it('credits complete payments as before and only records paid in-flight ones', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [
        makePayment({ payment_id: 701, payment_status: 'finished', outcome_amount: 2.0 }),
        makePayment({ payment_id: 702, payment_status: 'partially_paid', outcome_amount: 1.0 }),
        makePayment({ payment_id: 703, payment_status: 'confirming' }),
        makePayment({ payment_id: 704, payment_status: 'waiting', actually_paid: 0 }),
        makePayment({ payment_id: 705, payment_status: 'expired' }),
      ],
    });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result).toMatchObject({
      totalPayments: 5,
      completedPayments: 2,
      newlyProcessed: 2,
      alreadyProcessed: 0,
      failed: 0,
      skipped: 0,
      recordedOpen: 1,
    });
    expect(mockGrantBuzzPurchase.mock.calls.map(([a]) => a.externalTransactionId)).toEqual([
      'np-deposit-701',
      'np-deposit-702',
    ]);
    const created = mockDbWrite.cryptoDeposit.upsert.mock.calls.map(([a]: any) => [
      Number(a.create.paymentId),
      a.create.status,
    ]);
    expect(created).toContainEqual([703, 'confirming']);
    expect(created.map(([id]: any) => id)).not.toContain(704);
    expect(created.map(([id]: any) => id)).not.toContain(705);
  });

  it('leaves an in-flight row alone when it already holds that status', async () => {
    mockNowpaymentsCaller.getListPayments.mockResolvedValueOnce({
      data: [makePayment({ payment_id: 703, payment_status: 'confirming' })],
    });
    mockDbRead.cryptoDeposit.findUnique.mockResolvedValue({ status: 'confirming' });

    const result = await reconcileDeposits({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });

    expect(result.recordedOpen).toBe(0);
    expect(mockDbWrite.cryptoDeposit.upsert).not.toHaveBeenCalled();
  });
});

describe('watchOpenDeposits', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const openRow = (paymentId: number, status: string, ageDays: number) => ({
    paymentId: BigInt(paymentId),
    userId: 42,
    status,
    payCurrency: 'btc',
    payAmount: 10,
    createdAt: daysAgo(ageDays),
    user: { username: 'tester' },
  });
  /** The deposit row's status, applying processDeposit's conditional writes like Postgres would. */
  let rowStatus: Record<number, string>;

  beforeEach(() => {
    resetDepositMocks();
    rowStatus = {};
    mockDbWrite.cryptoDeposit.findUnique.mockImplementation(async ({ where }: any) =>
      rowStatus[Number(where.paymentId)] ? { status: rowStatus[Number(where.paymentId)] } : null
    );
    mockDbWrite.cryptoDeposit.updateMany.mockImplementation(async ({ where, data }: any) => {
      const id = Number(where.paymentId);
      if (where.status.notIn.includes(rowStatus[id])) return { count: 0 };
      rowStatus[id] = data.status;
      return { count: 1 };
    });
  });

  /** Serves findMany/count from `rows` by their where-clause, with statuses as the poll left them. */
  const watch = (rows: ReturnType<typeof openRow>[], npStatus: Record<number, string>) => {
    for (const r of rows) rowStatus[Number(r.paymentId)] = r.status;
    serveDepositTable(() => rows.map((r) => ({ ...r, status: rowStatus[Number(r.paymentId)] })));
    mockNowpaymentsCaller.getPaymentStatus.mockImplementation(async (id: number) =>
      npStatus[id] ? makePayment({ payment_id: id, payment_status: npStatus[id] }) : null
    );
    return watchOpenDeposits();
  };

  it('polls paid in-flight and partially_paid rows only', async () => {
    const result = await watch(
      [
        openRow(811, 'waiting', 5),
        openRow(812, 'confirming', 5),
        openRow(813, 'confirmed', 5),
        openRow(814, 'sending', 5),
        openRow(815, 'partially_paid', 5),
        { ...openRow(816, 'confirming', 5), payAmount: 0 },
        { ...openRow(817, 'finished', 5), buzzCredited: 5000 },
        openRow(818, 'held', 5),
        openRow(819, 'buzz_failed', 5),
        openRow(820, 'expired', 5),
      ],
      {}
    );

    const polled = mockNowpaymentsCaller.getPaymentStatus.mock.calls.map(([id]) => Number(id));
    expect(polled.sort()).toEqual([811, 812, 813, 814, 815]);
    expect(result.checked).toBe(5);
    expect(result.counts).toMatchObject({ open: 5, held: 1, finishedUncredited: 1 });
  });

  it('credits a payment that finished after the reconcile window, once', async () => {
    const result = await watch([openRow(801, 'confirming', 5)], { 801: 'finished' });

    expect(mockNowpaymentsCaller.getPaymentStatus).toHaveBeenCalledTimes(1);
    expect(mockGrantBuzzPurchase).toHaveBeenCalledTimes(1);
    expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionId: 'np-deposit-801', userId: 42 })
    );
    expect(rowStatus[801]).toBe('finished');
    expect(result).toMatchObject({ checked: 1, closed: 1, digest: [] });
    expect(result.counts.open).toBe(0);
  });

  it('holds a finished payment a staff hand grant already paid', async () => {
    vi.mocked(findHandGrantsForDeposit).mockResolvedValueOnce(staffTipCitingPayment);

    const result = await watch([openRow(802, 'confirming', 5)], { 802: 'finished' });

    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
    expect(rowStatus[802]).toBe('held');
    expect(result.closed).toBe(1);
  });

  it('credits a partially_paid row with no hand grant', async () => {
    const result = await watch([openRow(810, 'partially_paid', 5)], { 810: 'partially_paid' });

    expect(mockGrantBuzzPurchase).toHaveBeenCalledTimes(1);
    expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionId: 'np-deposit-810', userId: 42 })
    );
    expect(rowStatus[810]).toBe('finished');
    expect(result.closed).toBe(1);
  });

  it('holds a partially_paid row a staff hand grant already paid', async () => {
    vi.mocked(findHandGrantsForDeposit).mockResolvedValueOnce(staffTipCitingPayment);

    await watch([openRow(803, 'partially_paid', 5)], { 803: 'partially_paid' });

    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
    expect(rowStatus[803]).toBe('held');
  });

  it.each(['expired', 'refunded', 'failed'])('closes a row NOWPayments %s', async (closing) => {
    const result = await watch([openRow(804, 'confirmed', 5)], { 804: closing });

    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
    expect(rowStatus[804]).toBe(closing);
    expect(result).toMatchObject({ closed: 1, digest: [] });
  });

  it('lists rows open 3+ days in the digest and counts every open row', async () => {
    vi.mocked(findHandGrantsForDeposit).mockResolvedValueOnce(staffTipCitingPayment);

    const result = await watch(
      [
        openRow(805, 'confirmed', 9),
        openRow(806, 'confirming', 4),
        openRow(807, 'confirming', 1),
        openRow(809, 'confirming', 12),
      ],
      { 805: 'confirmed', 806: 'confirming', 807: 'confirming', 809: 'finished' }
    );

    expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
    expect(result.digest).toEqual([
      expect.objectContaining({ paymentId: '805', status: 'confirmed', daysOpen: 9, userId: 42 }),
      expect.objectContaining({ paymentId: '806', status: 'confirming', daysOpen: 4 }),
    ]);
    expect(result.counts).toEqual({ open: 3, oldestOpenDays: 9, held: 1, finishedUncredited: 0 });
  });

  it('keeps a row open when NOWPayments cannot be read', async () => {
    const result = await watch([openRow(808, 'confirming', 5)], {});

    expect(result).toMatchObject({ closed: 0, lookupFailed: 1 });
    expect(result.digest.map((i) => i.paymentId)).toEqual(['808']);
  });

  describe('listed payment ids with no row (lost IPN)', () => {
    /** Serves the two KeyValue lists; anything else reads as unset. */
    const listIds = (watchIds: unknown, creditOk: unknown = undefined) =>
      mockKvGet.mockImplementation(async (key: string, defaultValue?: unknown) => {
        if (key === 'nowpayments:watch-payment-ids') return watchIds;
        if (key === 'nowpayments:watch-payment-ids-credit-ok') return creditOk ?? defaultValue;
        return defaultValue;
      });
    const lookedUp = () =>
      mockNowpaymentsCaller.getPaymentStatus.mock.calls.map(([id]) => Number(id));

    beforeEach(() => {
      mockKvGet.mockReset().mockImplementation(async (_k: string, d?: unknown) => d);
    });

    it('(a) credits a listed, confirmed id that finished with no row', async () => {
      listIds([901], [901]);

      const result = await watch([], { 901: 'finished' });

      expect(lookedUp()).toEqual([901]);
      expect(mockGrantBuzzPurchase).toHaveBeenCalledTimes(1);
      expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
        expect.objectContaining({ externalTransactionId: 'np-deposit-901', userId: 42 })
      );
      expect(rowStatus[901]).toBe('finished');
      expect(result.listed).toEqual([{ paymentId: '901', state: 'recorded', status: 'finished' }]);
    });

    it('(b) never reads or credits a listed id whose row is held', async () => {
      listIds([902], [902]);

      const result = await watch([openRow(902, 'held', 5)], { 902: 'finished' });

      expect(mockNowpaymentsCaller.getPaymentStatus).not.toHaveBeenCalled();
      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      expect(rowStatus[902]).toBe('held');
      expect(result.listed).toEqual([{ paymentId: '902', state: 'held', status: 'held' }]);
    });

    it('(c) holds a listed id with no row that a staff hand grant cites', async () => {
      listIds([903], [903]);
      vi.mocked(findHandGrantsForDeposit).mockResolvedValueOnce(staffTipCitingPayment);

      const result = await watch([], { 903: 'finished' });

      expect(mockGrantBuzzPurchase).not.toHaveBeenCalled();
      expect(rowStatus[903]).toBe('held');
      expect(result.listed[0]).toMatchObject({ paymentId: '903', state: 'recorded' });
    });

    it('(d) looks up a listed id that also has an open row only once', async () => {
      listIds([904], [904]);

      const result = await watch([openRow(904, 'confirming', 5)], { 904: 'finished' });

      expect(lookedUp()).toEqual([904]);
      expect(mockGrantBuzzPurchase).toHaveBeenCalledTimes(1);
      expect(result.listed).toEqual([{ paymentId: '904', state: 'has_row', status: 'finished' }]);
    });

    it.each([
      ['unset', undefined],
      ['not an array', { ids: [905] }],
      ['a string', '905'],
    ])('(e) runs the row watch unchanged when the list is %s', async (_label, value) => {
      listIds(value);

      const result = await watch([openRow(801, 'confirming', 5)], {
        801: 'finished',
        905: 'finished',
      });

      expect(lookedUp()).toEqual([801]);
      expect(mockGrantBuzzPurchase).toHaveBeenCalledTimes(1);
      expect(result.listed).toEqual([]);
    });

    it('(e) skips entries that are not payment ids and checks the rest', async () => {
      listIds(['abc', -1, 1.5, 906, 906], [906]);

      const result = await watch([], { 906: 'confirming' });

      expect(lookedUp()).toEqual([906]);
      expect(result.listed).toEqual([
        { paymentId: '906', state: 'recorded', status: 'confirming' },
      ]);
    });

    it.each(['finished', 'partially_paid'])(
      '(f) does not credit a listed id already %s until it is on the credit-ok list',
      async (npStatus) => {
        listIds([907, 908], [908]);

        const result = await watch([], { 907: npStatus, 908: npStatus });

        expect(mockGrantBuzzPurchase).toHaveBeenCalledTimes(1);
        expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
          expect.objectContaining({ externalTransactionId: 'np-deposit-908' })
        );
        expect(rowStatus[907]).toBeUndefined();
        expect(mockDbWrite.cryptoDeposit.upsert).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: { paymentId: BigInt(907) } })
        );
        expect(result.listed).toEqual([
          { paymentId: '907', state: 'awaiting_ok', status: npStatus },
          { paymentId: '908', state: 'recorded', status: npStatus },
        ]);
      }
    );

    it('names a listed id NowPayments still has waiting, and one it cannot read', async () => {
      listIds([909, 910]);

      const result = await watch([], { 909: 'waiting' });

      expect(mockDbWrite.cryptoDeposit.upsert).not.toHaveBeenCalled();
      expect(result.listed).toEqual([
        { paymentId: '909', state: 'no_row', status: 'waiting' },
        { paymentId: '910', state: 'lookup_failed', status: null },
      ]);
    });
  });
});

describe('getOpenDepositReport', () => {
  beforeEach(resetDepositMocks);

  it('reads the open list and counts without calling NowPayments or writing', async () => {
    const day = 86_400_000;
    const row = (paymentId: bigint, status: string, ageDays: number, extra = {}) => ({
      paymentId,
      userId: 42,
      status,
      payCurrency: 'btc',
      payAmount: 10,
      createdAt: new Date(Date.now() - ageDays * day),
      user: { username: 'tester' },
      ...extra,
    });
    serveDepositTable(() => [
      row(901n, 'confirmed', 6),
      row(902n, 'held', 0, { user: null }),
      row(903n, 'partially_paid', 2),
      row(904n, 'finished', 1, { buzzCredited: null }),
      row(905n, 'finished', 1, { buzzCredited: 10000 }),
      row(906n, 'expired', 9),
    ]);

    const report = await getOpenDepositReport();

    expect(report.counts).toEqual({ open: 2, oldestOpenDays: 6, held: 1, finishedUncredited: 1 });
    expect(report.items.map((i) => [i.paymentId, i.held]).sort()).toEqual([
      ['901', false],
      ['902', true],
      ['903', false],
    ]);
    expect(mockNowpaymentsCaller.getPaymentStatus).not.toHaveBeenCalled();
    expect(mockDbWrite.cryptoDeposit.upsert).not.toHaveBeenCalled();
    expect(mockDbWrite.cryptoDeposit.updateMany).not.toHaveBeenCalled();
  });
});
