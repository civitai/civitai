import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import type * as BuzzService from '~/server/services/buzz.service';
import { getUserBuzzTransactionsResponse } from '~/server/schema/buzz.schema';
import { TransactionType } from '~/shared/constants/buzz.constants';

// The hand-grant scan runs for real here, against a fake ledger read through the real schema.
type LedgerRow = {
  type: string;
  fromAccountId: number;
  toAccountId: number;
  toAccountType: string;
  amount: number;
  description?: string;
  details?: Record<string, unknown>;
  externalTransactionId?: string;
  date: string;
};

const { ledger, grantBuzzPurchase, createTransaction, signalSend, createNotification } = vi.hoisted(
  () => ({
    ledger: [] as LedgerRow[],
    grantBuzzPurchase: vi.fn(async () => 'tx_granted'),
    createTransaction: vi.fn(async () => {
      throw new Error('ledger write');
    }),
    signalSend: vi.fn(async () => undefined),
    createNotification: vi.fn(async () => undefined),
  })
);

vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({
  default: {
    getPaymentStatus: async () => {
      throw new Error('NowPayments must not be called: the event carries the payin hash');
    },
  },
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  grantBuzzPurchase,
  getTransactionByExternalId: async (id: string) =>
    ledger.find((r) => r.externalTransactionId === id) ?? null,
  getMultipliersForUser: async () => ({ purchasesMultiplier: 1 }),
  buzzService: {
    createTransaction,
    getAccountTransactions: async (
      accountId: number,
      { accountType, query }: { accountType: string; query: { type: TransactionType } }
    ) => ({
      cursor: null,
      transactions: ledger
        .filter(
          (r) =>
            r.toAccountId === accountId &&
            r.type === TransactionType[query.type] &&
            r.toAccountType === { yellow: 'User', blue: 'Generation' }[accountType]
        )
        .map((r) => ({ ...r, fromAccountType: 'User' })),
    }),
  },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification }));
vi.mock('~/server/services/referral.service', () => ({
  recordBuzzPurchaseKickback: async () => undefined,
}));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: signalSend } }));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (_opts: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { processDeposit } = await import('~/server/services/nowpayments.service');
const { decideDepositCredit } = await import('~/server/services/nowpayments-settle-decision');

// Made-up ids; the payment id is above 2^31, as real ones are.
const PAYMENT_ID = 9123456789;
const USER_ID = 42;
const OTHER_SENDER = 777;

const event = (): NOWPayments.WebhookEvent => ({
  payment_id: PAYMENT_ID,
  payment_status: 'finished',
  order_id: `user:${USER_ID}`,
  actually_paid: 0.001,
  pay_currency: 'btc',
  outcome_amount: 20,
  outcome_currency: 'usdcbase',
  price_amount: 20,
  price_currency: 'usd',
  payin_hash: '0xfeedfacecafebeef',
  created_at: new Date('2026-10-20T08:00:00Z'),
});

function credit(row: Partial<LedgerRow> & { type: string }) {
  ledger.push({
    fromAccountId: 0,
    toAccountId: USER_ID,
    toAccountType: 'User',
    amount: 5_000,
    date: '2026-10-22T10:00:00.000Z',
    ...row,
  });
}

/** Support's top-up after paying a deposit by hand. */
const topUp = (entityId: unknown, extra: Partial<LedgerRow> = {}) =>
  credit({
    type: 'Reward',
    description: 'Crypto deposit top-up to value at payment',
    details: { kind: 'hand-paid', owed: 6_000, paid: 5_000, entityId },
    ...extra,
  });

/**
 * Runs processDeposit on a row in `status` and returns the row afterwards, applying the
 * conditional status write the way Postgres would.
 */
async function depositAfter(status: string, webhookStatus = 'finished') {
  const row = {
    status,
    createdAt: new Date('2026-10-20T08:00:00Z'),
    buzzCredited: null as number | null,
  };
  dbMock.dbWrite.cryptoDeposit.findUnique.mockImplementation(async () => ({ ...row }));
  dbMock.dbWrite.cryptoDeposit.upsert.mockImplementation(async ({ update }: any) => {
    row.buzzCredited = update.buzzCredited;
    return {};
  });
  dbMock.dbWrite.cryptoDeposit.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (where.status.notIn.includes(row.status)) return { count: 0 };
    row.status = data.status;
    return { count: 1 };
  });
  await processDeposit(PAYMENT_ID, webhookStatus, { ...event(), payment_status: webhookStatus });
  return row;
}

beforeEach(() => {
  ledger.length = 0;
  vi.clearAllMocks();
  grantBuzzPurchase.mockResolvedValue('tx_granted');
  // Nobody but the bank (account 0) is staff.
  dbMock.dbRead.user.findMany.mockResolvedValue([]);
});

describe('reading a transaction list with a string entityId', () => {
  it('coerces a numeric string and drops an unreadable one instead of failing the list', () => {
    const row = (entityId: unknown) => ({
      date: '2026-10-22T10:00:00.000Z',
      type: 'Reward',
      fromAccountId: 0,
      toAccountId: USER_ID,
      fromAccountType: 'User',
      toAccountType: 'User',
      amount: 1,
      details: entityId === undefined ? {} : { entityId },
    });
    const { transactions } = getUserBuzzTransactionsResponse.parse({
      cursor: null,
      transactions: [row(String(PAYMENT_ID)), row('np-x'), row(5), row(undefined)],
    });
    expect(transactions.map((t) => t.details?.entityId)).toEqual([
      PAYMENT_ID,
      undefined,
      5,
      undefined,
    ]);
  });
});

describe('a deposit Support already paid by hand', () => {
  it('settles a late deposit with a string-entityId top-up as hand_paid: no grant, nothing sent', async () => {
    topUp(String(PAYMENT_ID), { fromAccountId: OTHER_SENDER });

    const row = await depositAfter('failed');

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(row.status).toBe('hand_paid');
    expect(row.buzzCredited).toBeNull();
    expect(signalSend).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('settles on a top-up alone, with no base row, whose entityId is a number', async () => {
    topUp(PAYMENT_ID, {
      details: { kind: 'hand-paid(endpoint)', owed: 6_000, paid: 5_000, entityId: PAYMENT_ID },
    });

    const row = await depositAfter('expired');

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(row.status).toBe('hand_paid');
  });

  it('still holds a late deposit on a staff Tip naming the payment, next to a string-entityId row', async () => {
    credit({
      type: 'Tip',
      description: `Credit for BTC deposit (NowPayments ${PAYMENT_ID}) not credited automatically`,
      amount: 20_000,
    });
    credit({ type: 'Reward', details: { kind: 'other', entityId: '555' } });

    const row = await depositAfter('failed');

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(row.status).toBe('held');
  });

  it('holds, rather than grants, on a hand-paid top-up whose entityId it cannot read', async () => {
    topUp('np-x', { fromAccountId: OTHER_SENDER });

    for (const status of ['failed', 'buzz_failed']) {
      const row = await depositAfter(status);
      expect(grantBuzzPurchase).not.toHaveBeenCalled();
      expect(row.status).toBe('held');
    }
  });

  // Without the marker, a top-up is only a soft keyword match, and a non-late row grants on those.
  it('does not credit a second time when the row is not late', async () => {
    topUp(String(PAYMENT_ID));

    const row = await depositAfter('buzz_failed');

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(row.status).toBe('hand_paid');
  });

  it('keeps hand_paid against a later finished or failed notification', async () => {
    for (const later of ['finished', 'failed']) {
      const row = await depositAfter('hand_paid', later);
      expect(grantBuzzPurchase).not.toHaveBeenCalled();
      expect(row.status).toBe('hand_paid');
    }
  });
});

// Anyone can tip with any details; only a Reward can carry the hand-paid marker.
describe('a Tip forging the hand-paid marker', () => {
  it.each([
    ['naming the payment', PAYMENT_ID],
    ['with an unreadable entityId', 'np-x'],
  ])('is ignored %s, late or not', async (_, entityId) => {
    credit({
      type: 'Tip',
      fromAccountId: OTHER_SENDER,
      details: { kind: 'hand-paid', entityId },
    });

    for (const status of ['failed', 'buzz_failed']) {
      grantBuzzPurchase.mockClear();
      const row = await depositAfter(status);
      expect(grantBuzzPurchase).toHaveBeenCalledTimes(1);
      expect(row.status).toBe('finished');
    }
  });
});

describe('a deposit nobody paid by hand', () => {
  it('credits once', async () => {
    const row = await depositAfter('buzz_failed');

    expect(grantBuzzPurchase).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('finished');
  });

  it('credits once when the hand-paid top-up names another payment', async () => {
    topUp(String(PAYMENT_ID + 1), { fromAccountId: OTHER_SENDER });

    const row = await depositAfter('buzz_failed');

    expect(grantBuzzPurchase).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('finished');
  });
});

describe('decideDepositCredit', () => {
  it('decides from reads alone', async () => {
    const writes = [
      dbMock.dbWrite.cryptoDeposit.findUnique,
      dbMock.dbWrite.cryptoDeposit.upsert,
      dbMock.dbWrite.cryptoDeposit.updateMany,
      dbMock.dbWrite.cryptoDeposit.update,
    ];
    const input = {
      paymentId: PAYMENT_ID,
      userId: USER_ID,
      payinHash: null,
      expectedBuzz: 20_000,
      paymentCreatedAt: new Date('2026-10-20T08:00:00Z'),
      row: { status: 'failed', createdAt: new Date('2026-10-20T08:00:00Z') },
      lateStatus: 'failed',
      byModerator: false,
    };

    expect((await decideDepositCredit(input)).decision).toBe('grant');
    topUp('np-x');
    expect((await decideDepositCredit(input)).decision).toBe('held');
    topUp(String(PAYMENT_ID));
    expect(await decideDepositCredit(input)).toMatchObject({
      decision: 'already_granted',
      via: 'hand_paid',
    });
    for (const write of [...writes, grantBuzzPurchase, createTransaction])
      expect(write).not.toHaveBeenCalled();
  });
});

describe('the dry-run control that ignores the prior grant', () => {
  const input = {
    paymentId: PAYMENT_ID,
    userId: USER_ID,
    payinHash: null,
    expectedBuzz: 20_000,
    paymentCreatedAt: new Date('2026-10-20T08:00:00Z'),
    row: { status: 'finished', createdAt: new Date('2026-10-20T08:00:00Z') },
    lateStatus: undefined,
    byModerator: false,
  };
  const creditedNormally = () =>
    credit({ type: 'Purchase', externalTransactionId: `np-deposit-${PAYMENT_ID}`, amount: 20_000 });

  it('is off unless asked for: a normally credited deposit stops at its prior grant', async () => {
    creditedNormally();

    expect(await decideDepositCredit(input)).toMatchObject({
      decision: 'already_granted',
      via: 'np_deposit',
    });
    expect(await decideDepositCredit({ ...input, ignorePriorGrant: true })).toMatchObject({
      decision: 'grant',
    });
  });

  it('is never set by the deposit flow: a redelivery of a credited deposit grants nothing', async () => {
    creditedNormally();

    await depositAfter('buzz_failed');

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
  });
});
