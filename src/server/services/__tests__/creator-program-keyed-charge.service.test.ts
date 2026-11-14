import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { createFakeBuzzLedger } from './buzz-ledger.fake';
import { createFakeAdvisoryLocks, settle } from './charge-lock.fake';

/**
 * A Creator Program bank deposit or cash withdrawal whose Buzz write ends with an unknown outcome
 * (the ledger committed, the response was lost) must move the Buzz once across the creator's retry
 * with the same client key, and a withdrawal must create its CashWithdrawal row and send its
 * payment once. Driven against a fake ledger with the Buzz service's external-id semantics and
 * in-memory advisory locks for the record step.
 */

const { buzz, tipalti, cache, holds, depositLocks } = vi.hoisted(() => ({
  buzz: {
    createBuzzTransaction: vi.fn(),
    resendBuzzTransaction: vi.fn(),
    getTransactionByExternalId: vi.fn(),
    refundTransaction: vi.fn(),
    getCounterPartyBuzzTransactions: vi.fn(),
    getUserBuzzAccount: vi.fn(),
    getTopContributors: vi.fn(),
    createMultiAccountBuzzTransaction: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
  },
  tipalti: { payToTipaltiAccount: vi.fn() },
  cache: { fetchByKey: new Map<string, unknown>() },
  holds: { assertNoPayoutHold: vi.fn() },
  depositLocks: new Set<string>(),
}));

vi.mock('~/server/services/buzz.service', () => buzz);
vi.mock('~/server/services/user-payment-configuration.service', () => tipalti);
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: vi.fn().mockResolvedValue([{ balance: 0 }]) },
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: async (_key: string, fn: () => Promise<unknown>) => fn(),
  bustFetchThroughCache: vi.fn(),
  clearCacheByPattern: vi.fn(),
  // The cap cache and the cash cache: each answers what the test put under its key.
  createCachedObject: (config: { key: string }) => ({
    fetch: async () => cache.fetchByKey.get(config.key) ?? {},
    bust: vi.fn(),
    flush: vi.fn(),
  }),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/utils/signal-client', () => ({ signalClient: { topicSend: vi.fn() } }));
vi.mock('~/server/prom/client', () => ({ userUpdateCounter: { inc: vi.fn() } }));
vi.mock('~/utils/errorHandling', () => ({
  withRetries: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('~/server/services/creator-program-prepayout-review/hold', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertNoPayoutHold: holds.assertNoPayoutHold,
}));
vi.mock('~/server/services/creator-program-bankable', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Before the bankable-amount cutover: only the tier cap limits a deposit.
  getBankableAmount: vi.fn().mockResolvedValue(null),
}));
// The per-user deposit lock: taken or not, in memory (the Redis lock is tested on its own).
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async <T>(options: { key: string }, run: () => Promise<T>) => {
    if (depositLocks.has(options.key)) return null;
    depositLocks.add(options.key);
    try {
      return await run();
    } finally {
      depositLocks.delete(options.key);
    }
  },
}));

const { REDIS_KEYS } = await import('~/server/redis/client');
const { bankBuzz, withdrawCash, getMonthAccount } = await import('../creator-program.service');

// Literal, not imported: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const PAYMENT_REFUNDED_MESSAGE = 'The payment for this attempt was refunded. Please try again.';

const USER = 42;
const OTHER_USER = 77;
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const CAP = 625_000;
const DEPOSIT = 10_000;
const WITHDRAWAL = 10_000; // cents
const ACH_FEE = 200; // WITHDRAWAL_FEES.ACH: a fixed $2

let ledger: ReturnType<typeof createFakeBuzzLedger>;
let locks: ReturnType<typeof createFakeAdvisoryLocks>;

type Row = {
  id: string;
  userId: number;
  transactionId: string | null;
  amount: number;
  fee: number;
  status: string;
  metadata: Record<string, unknown>;
};
let rows: Row[];
let rowSeq = 0;

const createRow = async ({
  data,
}: {
  // The unkeyed path creates its row without a transaction id and sets it after the burn.
  data: Omit<Row, 'id' | 'metadata' | 'transactionId'> & { transactionId?: string };
}) => {
  if (data.transactionId && rows.some((r) => r.transactionId === data.transactionId))
    throw new Error('Unique constraint failed on the fields: (`transactionId`)');
  const row: Row = {
    ...data,
    transactionId: data.transactionId ?? null,
    metadata: {},
    id: `cw-${++rowSeq}`,
  };
  rows.push(row);
  return { id: row.id };
};
const findRow = async ({ where }: { where: { userId: number; transactionId: string } }) =>
  rows.find((r) => r.userId === where.userId && r.transactionId === where.transactionId) ?? null;
const txClient = () => ({ cashWithdrawal: { create: createRow, findFirst: findRow } });

/** The withdrawal rows a creator would see as live (not canceled). */
const liveRows = () => rows.filter((r) => r.status !== 'Canceled');

beforeAll(() => {
  // Mid-month: the banking phase is open.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  // A request a test left hanging must not hold the next test's deposit lock.
  depositLocks.clear();
  for (const fn of Object.values(buzz)) fn.mockReset();
  tipalti.payToTipaltiAccount.mockReset();
  holds.assertNoPayoutHold.mockReset().mockResolvedValue(undefined);
  ledger = createFakeBuzzLedger();
  locks = createFakeAdvisoryLocks();
  rows = [];

  // The app wrapper mints a new id per call when the caller passes none (buzz.service).
  buzz.createBuzzTransaction.mockImplementation((input: { externalTransactionId?: string }) =>
    ledger.createBuzzTransaction({
      ...input,
      externalTransactionId: input.externalTransactionId || crypto.randomUUID(),
    } as never)
  );
  buzz.resendBuzzTransaction.mockImplementation(ledger.resendBuzzTransaction);
  buzz.getTransactionByExternalId.mockImplementation(ledger.getTransactionByExternalId);
  buzz.refundTransaction.mockImplementation(ledger.refundTransaction);
  // The banked total: this month's deposits from the user still on the ledger (not refunded).
  buzz.getCounterPartyBuzzTransactions.mockImplementation(
    async ({ counterPartyAccountId, counterPartyAccountType }: Record<string, unknown>) => {
      const refunded = new Set(ledger.refunds().map((r) => r.externalTransactionId));
      const total =
        counterPartyAccountType === 'yellow'
          ? ledger
              .charges()
              .filter(
                (t) =>
                  t.fromAccountId === counterPartyAccountId &&
                  t.toAccountId === getMonthAccount() &&
                  !refunded.has(`refund-${t.transactionId}`)
              )
              .reduce((sum, t) => sum + t.amount, 0)
          : 0;
      return { counterPartyAccountType, totalBalance: total };
    }
  );
  buzz.getUserBuzzAccount.mockResolvedValue([{ balance: 0 }]);
  buzz.getTopContributors.mockResolvedValue({});

  let batch = 0;
  tipalti.payToTipaltiAccount.mockImplementation(async ({ requestId }: { requestId: string }) => ({
    paymentBatchId: `batch-${++batch}`,
    paymentRefCode: requestId,
  }));

  cache.fetchByKey.clear();
  cache.fetchByKey.set(REDIS_KEYS.CREATOR_PROGRAM.CAPS, {
    [USER]: {
      id: USER,
      definition: { tier: 'silver', limit: 1_000_000, percentOfPeakEarning: 1.25 },
      peakEarning: { month: new Date(), earned: 500_000 },
      cap: CAP,
      countsCompensation: false,
    },
  });
  cache.fetchByKey.set(REDIS_KEYS.CREATOR_PROGRAM.CASH, {
    [USER]: {
      id: USER,
      status: 'ready',
      ready: 100_000,
      pending: 0,
      withdrawn: 0,
      paymentMethod: 'ACH',
    },
  });

  const db = dbMock.dbWrite;
  db.user.findFirstOrThrow.mockResolvedValue({ id: USER, onboarding: 0 } as never);
  db.customerSubscription.findFirst.mockResolvedValue({
    product: { metadata: { tier: 'silver' } },
  } as never);
  db.userPaymentConfiguration.findUnique.mockResolvedValue({
    userId: USER,
    tipaltiPaymentsEnabled: true,
    tipaltiWithdrawalMethod: 'ACH',
  } as never);
  db.cashWithdrawal.create.mockImplementation(createRow as never);
  db.cashWithdrawal.findUniqueOrThrow.mockImplementation((async ({
    where,
  }: {
    where: { id: string };
  }) => {
    const row = rows.find((r) => r.id === where.id);
    if (!row) throw new Error('not found');
    return row;
  }) as never);
  db.cashWithdrawal.count.mockResolvedValue(0 as never);
  // The service's raw row updates, applied to the in-memory rows.
  db.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('?');
    const byId = (id: unknown) => rows.find((r) => r.id === id);
    if (sql.includes('SET "transactionId"')) {
      const row = byId(values[1]);
      if (row) row.transactionId = String(values[0]);
    } else if (sql.includes("'paymentRefCode', ") && sql.includes('IS NULL')) {
      const row = byId(values[1]);
      if (!row || row.metadata.paymentRefCode) return 0;
      row.metadata.paymentRefCode = values[0];
    } else if (sql.includes("'paymentBatchId'")) {
      const row = byId(values[values.length - 1]);
      if (row)
        row.metadata = {
          paymentBatchId: values[0],
          paymentRefCode: values[1],
          paidAmount: values[2],
        };
    } else if (sql.includes("status = 'Canceled'")) {
      const row = byId(values[values.length - 1]);
      if (row) row.status = 'Canceled';
    }
    return 1;
  }) as never);
  db.$transaction.mockImplementation(((
    cb: (tx: unknown) => Promise<unknown>,
    options?: { timeout?: number }
  ) => locks.transaction(cb, txClient(), options)) as never);
});

// Bounded: a request that failed before reaching the ledger never hangs.
const untilHung = async () => {
  for (let i = 0; i < 200 && !ledger.isHung(); i++) await settle();
  expect(ledger.isHung(), 'the write is hanging').toBe(true);
};
const outcome = (p: Promise<unknown>) => p.then(() => 'ok' as const).catch((e: unknown) => e);

// ─── bank deposit ──────────────────────────────────────────────────────────────
describe('bank deposit with a client key', () => {
  const bank = (key?: string, amount = DEPOSIT) => bankBuzz(USER, amount, 'yellow', key);

  it('a retry after an unanswered deposit banks once', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    const first = await outcome(bank(KEY));
    expect((first as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    ledger.clearFaults();

    await bank(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0]).toMatchObject({
      amount: DEPOSIT,
      fromAccountId: USER,
      toAccountId: getMonthAccount(),
      externalTransactionId: `creator-bank-deposit-${USER}-${KEY}`,
    });
  });

  it('continues from the deposit in the same request when the resend answers', async () => {
    ledger.queueFault('lose-response');

    await bank(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(buzz.resendBuzzTransaction).toHaveBeenCalledTimes(1);
  });

  it('answers a retry whose deposit filled the cap from that deposit, not "exceeds cap"', async () => {
    // The first deposit landed and used the whole cap; its answer was lost.
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await outcome(bank(KEY, CAP));
    ledger.clearFaults();

    await expect(bank(KEY, CAP)).resolves.toBeUndefined();
    expect(ledger.charges()).toHaveLength(1);
  });

  it('two requests with one key at once: one deposit; the other is told to wait (429, key kept)', async () => {
    ledger.queueFault('hang');
    const first = bank(KEY);
    await untilHung();

    const second = await outcome(bank(KEY));
    ledger.releaseHung();
    await first;

    expect(second).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(ledger.charges()).toHaveLength(1);
  });

  it('a lookup that fails before anything is checked is "may have gone through", and banks nothing', async () => {
    ledger.failLookups();

    const error = await outcome(bank(KEY));

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    expect(ledger.charges()).toHaveLength(0);
  });

  it('a hung deposit holds no database transaction', async () => {
    ledger.queueFault('hang');
    const pending = bank(KEY);
    await untilHung();

    expect(locks.open()).toBe(0);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();

    ledger.releaseHung();
    await pending;
  });

  it('a different key is a different deposit', async () => {
    await bank(KEY);
    await bank(OTHER_KEY);
    expect(ledger.charges()).toHaveLength(2);
  });

  it("one user's key never names another user's deposit", async () => {
    cache.fetchByKey.set(REDIS_KEYS.CREATOR_PROGRAM.CAPS, {
      [OTHER_USER]: { id: OTHER_USER, cap: CAP, countsCompensation: false },
    });
    dbMock.dbWrite.user.findFirstOrThrow.mockResolvedValue({
      id: OTHER_USER,
      onboarding: 0,
    } as never);
    await bankBuzz(OTHER_USER, DEPOSIT, 'yellow', KEY);
    cache.fetchByKey.set(REDIS_KEYS.CREATOR_PROGRAM.CAPS, {
      [USER]: { id: USER, cap: CAP, countsCompensation: false },
    });
    dbMock.dbWrite.user.findFirstOrThrow.mockResolvedValue({ id: USER, onboarding: 0 } as never);

    await bank(KEY);

    expect(ledger.charges().map((t) => t.fromAccountId)).toEqual([OTHER_USER, USER]);
  });

  it('a deposit since refunded is refused, so the client starts over', async () => {
    await bank(KEY);
    await ledger.refundTransaction(ledger.charges()[0].transactionId);

    const error = await outcome(bank(KEY));

    expect((error as Error).message).toBe(PAYMENT_REFUNDED_MESSAGE);
    expect(ledger.charges()).toHaveLength(1);
  });

  describe('keeps every limit for a new deposit', () => {
    it('clamps to the cap left', async () => {
      await bank(OTHER_KEY, CAP - 4_000);
      await bank(KEY, DEPOSIT);
      expect(ledger.charges().map((t) => t.amount)).toEqual([CAP - 4_000, 4_000]);
    });

    it('refuses once the cap is used up', async () => {
      await bank(OTHER_KEY, CAP);
      await expect(bank(KEY)).rejects.toThrow('Amount exceeds cap');
      expect(ledger.charges()).toHaveLength(1);
    });

    it('refuses blue Buzz', async () => {
      await expect(bankBuzz(USER, DEPOSIT, 'blue', KEY)).rejects.toThrow('cannot bank Blue');
      expect(ledger.charges()).toHaveLength(0);
    });

    it('refuses outside the banking phase', async () => {
      vi.setSystemTime(new Date('2026-04-30T12:00:00Z'));
      try {
        await expect(bank(KEY)).rejects.toThrow('Banking phase is closed');
      } finally {
        vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
      }
      expect(buzz.getTransactionByExternalId).not.toHaveBeenCalled();
      expect(ledger.charges()).toHaveLength(0);
    });

    it('passes a short balance through as a refusal, without a resend', async () => {
      ledger.setBalance(USER, DEPOSIT - 1);
      await expect(bank(KEY)).rejects.toThrow(/enough funds/);
      expect(buzz.resendBuzzTransaction).not.toHaveBeenCalled();
      expect(ledger.charges()).toHaveLength(0);
    });
  });

  it('without a key, as before: no lookup, a new ledger id per call', async () => {
    await bank();
    await bank();
    expect(buzz.getTransactionByExternalId).not.toHaveBeenCalled();
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).not.toHaveProperty('externalTransactionId');
    expect(ledger.charges()).toHaveLength(2);
  });

  it('without a key, a busy lock is still a 400', async () => {
    ledger.queueFault('hang');
    const first = bank();
    await untilHung();
    const second = await outcome(bank());
    ledger.releaseHung();
    await first;
    expect(second).toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ─── cash withdrawal ───────────────────────────────────────────────────────────
describe('cash withdrawal with a client key', () => {
  const withdraw = (key?: string, amount = WITHDRAWAL) => withdrawCash(USER, amount, key);
  const burnId = `creator-cash-withdrawal-${USER}-${KEY}`;

  it('a retry after an unanswered burn burns once, records once and pays once', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    const first = await outcome(withdraw(KEY));
    expect((first as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    ledger.clearFaults();

    await withdraw(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0]).toMatchObject({
      amount: WITHDRAWAL,
      fromAccountId: USER,
      externalTransactionId: burnId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transactionId: ledger.charges()[0].transactionId,
      amount: WITHDRAWAL - ACH_FEE,
      fee: ACH_FEE,
      status: 'InternalValue',
    });
    expect(rows[0].metadata.paymentBatchId).toBe('batch-1');
    expect(tipalti.payToTipaltiAccount).toHaveBeenCalledTimes(1);
  });

  it('a retry after a lost success burns nothing, records nothing and pays nothing more', async () => {
    await withdraw(KEY);

    await withdraw(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(tipalti.payToTipaltiAccount).toHaveBeenCalledTimes(1);
  });

  it('a retry whose burn spent the whole balance continues from it instead of refusing', async () => {
    ledger.setBalance(USER, WITHDRAWAL);
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await outcome(withdraw(KEY));
    ledger.clearFaults();

    await withdraw(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(liveRows()).toHaveLength(1);
    expect(tipalti.payToTipaltiAccount).toHaveBeenCalledTimes(1);
  });

  it('two requests with one key at once: one burn, one row, one payment', async () => {
    ledger.queueFault('hang');
    const first = outcome(withdraw(KEY));
    await untilHung();
    const second = outcome(withdraw(KEY));
    await settle();
    ledger.releaseHung();

    const results = await Promise.all([first, second]);

    expect(results).toContain('ok');
    for (const r of results)
      if (r !== 'ok') expect((r as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(ledger.charges()).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(tipalti.payToTipaltiAccount).toHaveBeenCalledTimes(1);
  });

  it('a retry while the first request is still sending the payment is "may have gone through", not done', async () => {
    // A holder, not a `let`: assigned in a callback, which control-flow narrowing cannot see.
    const payment: { release?: () => void } = {};
    tipalti.payToTipaltiAccount.mockImplementationOnce(
      ({ requestId }: { requestId: string }) =>
        new Promise((resolve) => {
          payment.release = () => resolve({ paymentBatchId: 'batch-1', paymentRefCode: requestId });
        })
    );
    const first = withdraw(KEY);
    for (let i = 0; i < 200 && payment.release === undefined; i++) await settle();
    expect(rows, 'the first request recorded its row').toHaveLength(1);

    const second = await outcome(withdraw(KEY));
    payment.release?.();
    await first;

    expect((second as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(ledger.charges()).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(tipalti.payToTipaltiAccount).toHaveBeenCalledTimes(1);
  });

  it('a lookup that fails before burning is "may have gone through", and burns and records nothing', async () => {
    ledger.failLookups();

    const error = await outcome(withdraw(KEY));

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(buzz.createBuzzTransaction).not.toHaveBeenCalled();
    expect(ledger.charges()).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('a hung burn holds no database transaction; the row is written after it, under the key lock', async () => {
    ledger.queueFault('hang');
    const pending = withdraw(KEY);
    await untilHung();

    expect(locks.open()).toBe(0);
    expect(rows).toHaveLength(0);

    ledger.releaseHung();
    await pending;
    expect(locks.taken()).toEqual([burnId]);
    expect(rows).toHaveLength(1);
  });

  it('a row that fails to write has its burn refunded under the lock, once', async () => {
    const fail = vi.fn().mockRejectedValueOnce(new Error('insert failed'));
    dbMock.dbWrite.$transaction.mockImplementation(((
      cb: (tx: unknown) => Promise<unknown>,
      options?: { timeout?: number }
    ) =>
      locks.transaction(
        cb,
        { cashWithdrawal: { findFirst: findRow, create: (a: never) => fail(a) } },
        options
      )) as never);

    await expect(withdraw(KEY)).rejects.toThrow('insert failed');

    expect(ledger.refunds()).toHaveLength(1);
    expect(buzz.refundTransaction.mock.calls[0][3]).toEqual({ timeoutMs: 10_000, retries: 0 });
    expect(locks.taken()).toEqual([burnId, burnId]);
    expect(tipalti.payToTipaltiAccount).not.toHaveBeenCalled();
  });

  it('a payment that fails refunds the burn and cancels the row; a retry is told to start over', async () => {
    tipalti.payToTipaltiAccount.mockRejectedValueOnce(new Error('tipalti down'));
    await expect(withdraw(KEY)).rejects.toThrow('tipalti down');
    expect(ledger.refunds()).toHaveLength(1);
    expect(rows[0].status).toBe('Canceled');

    const error = await outcome(withdraw(KEY));

    expect((error as Error).message).toBe(PAYMENT_REFUNDED_MESSAGE);
    expect(ledger.charges()).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(tipalti.payToTipaltiAccount).toHaveBeenCalledTimes(1);
  });

  it('a burn refunded while waiting for the key lock is refused, and nothing is recorded or paid', async () => {
    locks.onNextLock(async () => {
      await ledger.refundTransaction(ledger.charges()[0].transactionId);
    });

    const error = await outcome(withdraw(KEY));

    expect((error as Error).message).toBe(PAYMENT_REFUNDED_MESSAGE);
    expect(rows).toHaveLength(0);
    expect(tipalti.payToTipaltiAccount).not.toHaveBeenCalled();
  });

  it('a different key is a different withdrawal', async () => {
    await withdraw(KEY);
    await withdraw(OTHER_KEY);
    expect(ledger.charges()).toHaveLength(2);
    expect(rows).toHaveLength(2);
  });

  describe('keeps every check for a new withdrawal', () => {
    it('refuses an amount below the minimum before burning', async () => {
      await expect(withdraw(KEY, 100)).rejects.toThrow('below minimum');
      expect(buzz.getTransactionByExternalId).not.toHaveBeenCalled();
      expect(ledger.charges()).toHaveLength(0);
    });

    it('refuses while a payout hold is open, before burning', async () => {
      holds.assertNoPayoutHold.mockRejectedValueOnce(new Error('Payouts are on hold'));
      await expect(withdraw(KEY)).rejects.toThrow('on hold');
      expect(ledger.charges()).toHaveLength(0);
      expect(rows).toHaveLength(0);
    });

    it('refuses a creator who is not payable, before burning', async () => {
      dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValueOnce({
        userId: USER,
        tipaltiPaymentsEnabled: false,
        tipaltiWithdrawalMethod: 'ACH',
      } as never);
      await expect(withdraw(KEY)).rejects.toThrow('not payable');
      expect(ledger.charges()).toHaveLength(0);
    });

    it('passes a short balance through as a refusal, without a resend or a row', async () => {
      ledger.setBalance(USER, WITHDRAWAL - 1);
      await expect(withdraw(KEY)).rejects.toThrow(/enough funds/);
      expect(buzz.resendBuzzTransaction).not.toHaveBeenCalled();
      expect(rows).toHaveLength(0);
    });
  });

  it('without a key, as before: row first, then a burn under a new id per call', async () => {
    await withdraw();
    await withdraw();
    expect(buzz.getTransactionByExternalId).not.toHaveBeenCalled();
    expect(buzz.createBuzzTransaction.mock.calls[0][0]).not.toHaveProperty('externalTransactionId');
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    expect(ledger.charges()).toHaveLength(2);
  });
});
