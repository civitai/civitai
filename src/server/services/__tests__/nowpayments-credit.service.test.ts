import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ModeratorService from '~/server/services/moderator.service';
import { TransactionType } from '~/shared/constants/buzz.constants';

type LedgerRow = {
  externalTransactionId?: string;
  type: string;
  fromAccountId: number;
  toAccountId: number;
  toAccountType: string;
  amount: number;
  description?: string;
  date: string;
};

// The Buzz ledger, faked with its one property that matters here: a key is used once.
const { ledger, lookupPayment, grantBuzzPurchase, trackModActivity, lock, scan } = vi.hoisted(
  () => {
    const ledger: LedgerRow[] = [];
    return {
      ledger,
      lookupPayment: vi.fn(),
      grantBuzzPurchase: vi.fn(
        async ({
          userId,
          amount,
          externalTransactionId,
        }: {
          userId: number;
          amount: number;
          externalTransactionId: string;
        }) => {
          if (ledger.some((r) => r.externalTransactionId === externalTransactionId))
            throw new Error('Request would conflict with the transaction');
          ledger.push({
            externalTransactionId,
            type: 'Purchase',
            fromAccountId: 0,
            toAccountId: userId,
            toAccountType: 'User',
            amount,
            date: new Date().toISOString(),
          });
          return `tx_${ledger.length}`;
        }
      ),
      trackModActivity: vi.fn(async () => undefined),
      lock: { held: false },
      scan: { down: false },
    };
  }
);

vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({
  default: {
    lookupPayment,
    getPaymentStatus: async (id: number) => (await lookupPayment(id)).payment,
  },
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  grantBuzzPurchase,
  getTransactionByExternalId: async (id: string) =>
    ledger.find((r) => r.externalTransactionId === id) ?? null,
  getMultipliersForUser: async () => ({ purchasesMultiplier: 1 }),
  buzzService: {
    getAccountTransactions: async (
      accountId: number,
      { accountType, query }: { accountType: string; query: { type: TransactionType } }
    ) => {
      if (scan.down) throw new Error('Buzz service unavailable');
      return {
        cursor: null,
        transactions: ledger
          .filter(
            (r) =>
              r.toAccountId === accountId &&
              r.type === TransactionType[query.type] &&
              r.toAccountType === { yellow: 'User', blue: 'Generation' }[accountType]
          )
          .map((r) => ({ ...r, fromAccountType: 'User' })),
      };
    },
  },
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: async () => undefined,
}));
vi.mock('~/server/services/referral.service', () => ({
  recordBuzzPurchaseKickback: async () => undefined,
}));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: async () => undefined } }));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (_opts: unknown, fn: () => Promise<unknown>) => {
    if (lock.held) return null;
    lock.held = true;
    try {
      return await fn();
    } finally {
      lock.held = false;
      scan.down = false;
    }
  },
}));

const { creditDeposit, previewDepositCredit, matchManualCredit } = await import(
  '~/server/services/nowpayments-credit.service'
);

const PAYMENT_ID = 5012345678;
const USER_ID = 42;
const MOD_ID = 7;
const PAYIN_HASH = '0xbf7255aa11223344556677889900aabbccddeeff00112233445566778899aabb';

function livePayment(overrides: Record<string, unknown> = {}) {
  lookupPayment.mockResolvedValue({
    status: 200,
    payment: {
      payment_id: PAYMENT_ID,
      payment_status: 'finished',
      order_id: `user:${USER_ID}`,
      pay_address: '0xaddr',
      price_amount: 20,
      price_currency: 'usd',
      pay_amount: 0.0003,
      pay_currency: 'btc',
      actually_paid: 0.0003,
      outcome_amount: 20,
      outcome_currency: 'usdcbase',
      payin_hash: PAYIN_HASH,
      created_at: new Date('2026-10-24T08:00:00Z'),
      updated_at: new Date('2026-10-24T09:00:00Z'),
      ...overrides,
    },
  });
}

/** A hand grant from support, as Freshdesk tickets have been paid. */
function supportTip(description: string, amount = 20_000, from = 0) {
  grant({ type: 'Tip', description, amount, from, key: 'support-ticket-90001' });
}

function grant({
  type,
  description,
  amount,
  from = 0,
  key,
}: {
  type: string;
  description: string;
  amount: number;
  from?: number;
  key?: string;
}) {
  ledger.push({
    externalTransactionId: key,
    type,
    fromAccountId: from,
    toAccountId: USER_ID,
    toAccountType: 'User',
    amount,
    description,
    date: '2026-10-24T10:00:00.000Z',
  });
}

const deposits = () => ledger.filter((r) => r.externalTransactionId?.startsWith('np-deposit-'));
const credit = (acknowledge?: string[]) =>
  creditDeposit({ paymentId: PAYMENT_ID, modUserId: MOD_ID, acknowledge, ticketId: '90002' });

beforeEach(() => {
  ledger.length = 0;
  lock.held = false;
  vi.clearAllMocks();
  dbMock.dbRead.user.findUnique.mockResolvedValue({ id: USER_ID, username: 'depositor' });
  dbMock.dbRead.user.findMany.mockResolvedValue([]);
  dbMock.dbRead.cryptoDeposit.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.cryptoDeposit.upsert.mockResolvedValue({});
  dbMock.dbWrite.cryptoDeposit.updateMany.mockResolvedValue({ count: 1 });
  livePayment();
});

describe('creditDeposit', () => {
  it('credits a finished payment once, on np-deposit-<id>, at the settled amount', async () => {
    const result = await credit();

    expect(result).toMatchObject({ credited: true, decision: 'credit' });
    expect(deposits()).toEqual([
      expect.objectContaining({
        externalTransactionId: `np-deposit-${PAYMENT_ID}`,
        amount: 20_000,
      }),
    ]);
    expect(grantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ creditedBy: MOD_ID, ticketId: '90002' })
    );
    expect(trackModActivity).toHaveBeenCalledWith(MOD_ID, {
      entityType: 'user',
      entityId: USER_ID,
      activity: `creditCryptoDeposit:${PAYMENT_ID}:20000`,
    });
  });

  it('credits partially_paid on what NowPayments settled', async () => {
    livePayment({ payment_status: 'partially_paid', outcome_amount: 7.5 });

    expect(await credit()).toMatchObject({ credited: true });
    expect(deposits()).toEqual([expect.objectContaining({ amount: 7_500 })]);
  });

  it.each(['confirmed', 'confirming', 'sending', 'waiting'])(
    'credits nothing while NowPayments says %s',
    async (payment_status) => {
      livePayment({ payment_status });

      const result = await credit();
      expect(result).toMatchObject({ credited: false, decision: 'waiting' });
      expect(result.reason).toMatch(/Waiting on NowPayments/);
      expect(grantBuzzPurchase).not.toHaveBeenCalled();
    }
  );

  it('refuses a second credit of the same payment', async () => {
    await credit();
    const second = await credit();

    expect(second).toMatchObject({ credited: false, decision: 'refused' });
    expect(second.reason).toMatch(/Already credited/);
    expect(grantBuzzPurchase).toHaveBeenCalledTimes(1);
  });

  it('refuses a payment the deposit table already shows credited', async () => {
    dbMock.dbRead.cryptoDeposit.findUnique.mockResolvedValue({
      status: 'finished',
      buzzCredited: 20_000,
    });

    expect(await credit()).toMatchObject({ credited: false, decision: 'refused' });
    expect(grantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('refuses a payment credited by hand against its payin hash', async () => {
    ledger.push({
      externalTransactionId: `np-payin-${PAYIN_HASH}`,
      type: 'Purchase',
      fromAccountId: 0,
      toAccountId: USER_ID,
      toAccountType: 'User',
      amount: 20_000,
      date: '2026-10-24T10:00:00.000Z',
    });

    const preview = await previewDepositCredit({ paymentId: PAYMENT_ID, modUserId: MOD_ID });
    expect(preview).toMatchObject({ decision: 'refused' });
    expect(preview.reason).toMatch(/payin hash/);
    expect(await credit()).toMatchObject({ credited: false });
    expect(grantBuzzPurchase).not.toHaveBeenCalled();
  });

  // The double payment this exists to stop: support tipped a deposit stuck at `confirmed`,
  // then NowPayments finished it.
  it('refuses a payment a support Tip already paid, and acknowledge cannot override it', async () => {
    supportTip(
      `Crypto deposit not credited - NP payment ${PAYMENT_ID}, 0.0003 BTC - ticket #90001`
    );

    const refused = await credit(['support-ticket-90001']);
    expect(refused).toMatchObject({ credited: false, decision: 'refused' });
    expect(refused.matches).toEqual([
      expect.objectContaining({ strength: 'hard', ref: 'support-ticket-90001' }),
    ]);
    expect(deposits()).toEqual([]);
  });

  it('refuses a Tip that cites only a 6-hex prefix of the payin hash', async () => {
    supportTip('Manual credit for tx 0xbf7255… - ticket #90001', 1);

    const result = await credit(['support-ticket-90001']);
    expect(result).toMatchObject({ credited: false, decision: 'refused' });
    expect(result.matches[0]).toMatchObject({ strength: 'hard', why: 'cites the payin hash' });
  });

  it('holds a staff Tip that mentions a deposit until it is acknowledged', async () => {
    supportTip('BTC deposit stuck at confirmed - manual credit - ticket #90001', 1);

    const held = await credit();
    expect(held).toMatchObject({ credited: false, decision: 'refused' });
    expect(held.matches).toEqual([
      expect.objectContaining({ strength: 'soft', ref: 'support-ticket-90001' }),
    ]);
    expect(grantBuzzPurchase).not.toHaveBeenCalled();

    expect(await credit(['support-ticket-90001'])).toMatchObject({ credited: true });
  });

  it('holds a staff Tip worth 80% of the deposit until it is acknowledged', async () => {
    supportTip('Goodwill - ticket #90001', 16_000);

    expect(await credit()).toMatchObject({ credited: false, decision: 'refused' });
    expect(await credit(['support-ticket-90001'])).toMatchObject({ credited: true });
  });

  it('counts a Tip from a moderator as a staff grant', async () => {
    supportTip('Goodwill - ticket #90001', 16_000, MOD_ID);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: MOD_ID }]);

    expect(await credit()).toMatchObject({ credited: false, decision: 'refused' });
  });

  it('holds a goodwill Reward from the bank that mentions a crypto deposit', async () => {
    grant({
      type: 'Reward',
      description: 'Goodwill Buzz - Ticket #90001 crypto deposit',
      amount: 1,
    });

    const held = await credit();
    expect(held).toMatchObject({ credited: false, decision: 'refused' });
    expect(held.matches).toEqual([expect.objectContaining({ type: 'Reward', strength: 'soft' })]);
  });

  it('ignores an automated Reward from the bank even at the exact deposit amount', async () => {
    grant({ type: 'Reward', description: 'Ad impression reward', amount: 20_000 });

    expect(await credit()).toMatchObject({ credited: true, matches: [] });
  });

  it('holds a staff Refund that mentions a deposit', async () => {
    grant({ type: 'Refund', description: 'Refund for BTC deposit - ticket #90001', amount: 1 });

    expect(await credit()).toMatchObject({ credited: false, decision: 'refused' });
  });

  it('holds an old mod-cash disbursement for a failed payment', async () => {
    grant({
      type: 'Incentive',
      description: 'Mod cash adjustment (grant): Disbursement for failed 07/19/2026 payment',
      amount: 1,
      key: 'mod-cash-7-42-1784000000000',
    });

    const held = await credit();
    expect(held).toMatchObject({ credited: false, decision: 'refused' });
    expect(held.matches).toEqual([expect.objectContaining({ strength: 'soft' })]);
  });

  it('refuses when it cannot read the ledger for hand grants', async () => {
    scan.down = true;

    const result = await credit();
    expect(result).toMatchObject({ credited: false, decision: 'refused' });
    expect(result.reason).toMatch(/Could not check/);
    expect(grantBuzzPurchase).not.toHaveBeenCalled();
  });

  it('turns away a second credit while one is running', async () => {
    lock.held = true;

    await expect(credit()).rejects.toThrow(/already running/);
    expect(grantBuzzPurchase).not.toHaveBeenCalled();
  });
});

describe('previewDepositCredit', () => {
  it('shows what it would credit and to whom, and writes nothing', async () => {
    const preview = await previewDepositCredit({ paymentId: PAYMENT_ID, modUserId: MOD_ID });

    expect(preview).toMatchObject({
      decision: 'credit',
      status: 'finished',
      user: { id: USER_ID, username: 'depositor' },
      actuallyPaid: { amount: 0.0003, currency: 'btc' },
      outcome: { amount: 20, currency: 'usdcbase' },
      buzz: { base: 20_000 },
    });
    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.cryptoDeposit.upsert).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

describe('matchManualCredit', () => {
  const base = {
    ref: 'r',
    date: '2026-10-24T10:00:00.000Z',
    type: 'Tip',
    amount: 1,
    accountType: 'yellow',
    fromAccountId: 0,
    externalTransactionId: null,
  };
  const ctx = {
    paymentId: PAYMENT_ID,
    payinHash: PAYIN_HASH,
    expectedBuzz: 20_000,
    fromStaff: true,
  };

  it('does not read a longer number containing the payment id as the payment id', () => {
    expect(matchManualCredit({ ...base, description: `ref 9${PAYMENT_ID}9` }, ctx)).toBeNull();
  });

  it('ignores a staff Tip unrelated in both wording and amount', () => {
    expect(matchManualCredit({ ...base, description: 'Contest prize' }, ctx)).toBeNull();
  });
});

describe('automatic deposit credit (webhook, reconcile, sweep, reprocess)', () => {
  // The deposit row, with the status ordering processDeposit asks Postgres for.
  let row: { status: string; buzzCredited: number | null } | null;

  beforeEach(() => {
    row = null;
    const find = async () => row && { ...row, createdAt: new Date('2026-10-24T08:00:00Z') };
    dbMock.dbRead.cryptoDeposit.findUnique.mockImplementation(find);
    dbMock.dbWrite.cryptoDeposit.findUnique.mockImplementation(find);
    dbMock.dbWrite.cryptoDeposit.upsert.mockImplementation(async ({ create, update }: any) => {
      row = row
        ? { ...row, buzzCredited: update.buzzCredited }
        : { status: create.status, buzzCredited: create.buzzCredited };
      return {};
    });
    dbMock.dbWrite.cryptoDeposit.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (!row || where.status?.notIn?.includes(row.status)) return { count: 0 };
      row = { ...row, status: data.status };
      return { count: 1 };
    });
  });

  const ipn = async () => {
    const { processDeposit, eventFromPayment } = await import(
      '~/server/services/nowpayments.service'
    );
    const { payment } = await lookupPayment(PAYMENT_ID);
    return processDeposit(PAYMENT_ID, payment.payment_status, eventFromPayment(payment));
  };
  const flagged = () =>
    vi
      .mocked(loggingMock.logToAxiom)
      .mock.calls.map(([data]) => (data as { message?: string }).message)
      .filter((m) => m?.startsWith('Deposit held') || m?.startsWith('Deposit credited with'));

  it('credits a deposit nothing on the ledger already covers', async () => {
    await ipn();

    expect(deposits()).toHaveLength(1);
    expect(row?.status).toBe('finished');
    expect(flagged()).toEqual([]);
  });

  it('holds, without crediting, a deposit a staff Tip citing the payment id already paid', async () => {
    row = { status: 'confirming', buzzCredited: null };
    supportTip(`Crypto deposit ${PAYMENT_ID} not received`);

    const result = await ipn();

    expect(deposits()).toEqual([]);
    expect(row).toMatchObject({ status: 'held', buzzCredited: null });
    expect(result.transactionId).toBeUndefined();
    expect(flagged()).toEqual(['Deposit held: a hand grant cites this payment']);
  });

  it('holds a deposit a staff Tip citing a payin hash prefix already paid', async () => {
    supportTip('Manual credit for tx 0xbf7255aa');

    await ipn();

    expect(deposits()).toEqual([]);
    expect(row?.status).toBe('held');
  });

  it('keeps a held deposit uncredited when NowPayments redelivers it', async () => {
    supportTip(`Crypto deposit ${PAYMENT_ID} not received`);
    await ipn();
    // The hold must not depend on the scan finding the grant a second time.
    ledger.length = 0;

    await ipn();
    const { reprocessDeposit } = await import('~/server/services/nowpayments.service');
    await reprocessDeposit(PAYMENT_ID);

    expect(deposits()).toEqual([]);
    expect(row?.status).toBe('held');
  });

  it('credits past a soft match and flags it', async () => {
    supportTip('Goodwill for the crypto deposit issue');

    await ipn();

    expect(deposits()).toHaveLength(1);
    expect(row?.status).toBe('finished');
    expect(flagged()).toEqual(['Deposit credited with possible hand grant']);
  });

  it('credits past a citing grant from a non-staff account and flags it', async () => {
    grant({ type: 'Tip', description: `re ${PAYMENT_ID}`, amount: 1, from: 99 });

    await ipn();

    expect(deposits()).toHaveLength(1);
    expect(flagged()).toEqual(['Deposit credited with possible hand grant']);
  });

  it('leaves the deposit to the retry sweep when it cannot read the ledger', async () => {
    scan.down = true;

    await ipn();

    expect(deposits()).toEqual([]);
    expect(row?.status).toBe('buzz_failed');
  });

  it('leaves the deposit to the retry sweep while a credit for it is running', async () => {
    lock.held = true;

    await ipn();

    expect(deposits()).toEqual([]);
    expect(row?.status).toBe('buzz_failed');
  });

  it('keeps a credited deposit credited when a citing grant appears later', async () => {
    await ipn();
    supportTip(`Crypto deposit ${PAYMENT_ID} not received`);

    await ipn();

    expect(deposits()).toHaveLength(1);
    expect(row?.status).toBe('finished');
  });
});
