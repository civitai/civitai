import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TRPCError } from '@trpc/server';
import {
  CHARGE_LOCK_WAIT,
  CHARGE_LOCK_WAIT_MS,
  CHARGE_LOCKED_READ,
  CHARGE_LOCKED_REFUND,
  CHARGE_RECORD_TRANSACTION_TIMEOUT_MS,
  CHARGE_STATEMENT_TIMEOUT,
  CHARGE_STATEMENT_TIMEOUT_MS,
  recordKeyedCharge,
  recordStepError,
  refundUnlessRecorded,
  withChargeKeyLock,
} from '~/server/services/buzz-charge-lock';
import { createFakeAdvisoryLocks } from './charge-lock.fake';

// Literal: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";

const statements: { sql: string; values: unknown[] }[] = [];
const tx = {
  $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ sql: strings.join('?'), values });
    return 0;
  }),
};

beforeEach(() => {
  statements.length = 0;
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (t: unknown) => unknown) =>
    cb(tx)) as never);
});

describe('withChargeKeyLock', () => {
  it('bounds the wait, locks the key, bounds each statement, then runs the work in that transaction', async () => {
    const run = vi.fn(async (t: unknown) => {
      expect(t).toBe(tx);
      expect(statements).toHaveLength(4);
      return 'done';
    });

    await expect(withChargeKeyLock('the-key', { userId: 1 }, run)).resolves.toBe('done');

    expect(statements).toEqual([
      { sql: "SELECT set_config('lock_timeout', ?, true)", values: ['10s'] },
      { sql: 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', values: ['the-key'] },
      { sql: 'SET LOCAL lock_timeout TO DEFAULT', values: [] },
      { sql: "SELECT set_config('statement_timeout', ?, true)", values: ['5s'] },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    // A short transaction: database work, a bounded ledger read, and at most a bounded refund.
    expect((dbMock.dbWrite.$transaction.mock.calls[0] as unknown[])[1]).toEqual({
      timeout: 45_000,
    });
  });

  it('a lock wait past its bound is "may have gone through", not a hang or a refusal', async () => {
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('canceling statement due to lock timeout', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '55P03' },
      })
    );

    await expect(withChargeKeyLock('the-key', { userId: 1 }, vi.fn())).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
  });

  it('passes any other failure through unchanged', async () => {
    const failure = new Error('boom');
    await expect(
      withChargeKeyLock('the-key', { userId: 1 }, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});

describe('refundUnlessRecorded', () => {
  const refund = vi.fn(async () => undefined);

  it('refunds a charge nobody recorded, under the key lock', async () => {
    await expect(
      refundUnlessRecorded(
        'the-key',
        { userId: 1 },
        {
          isRecorded: async () => false,
          isRefunded: async () => false,
          refund,
        }
      )
    ).resolves.toBe('refunded');
    expect(refund).toHaveBeenCalledTimes(1);
    expect(statements.some((s) => s.sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('leaves a charge another request recorded', async () => {
    await expect(
      refundUnlessRecorded(
        'the-key',
        { userId: 1 },
        {
          isRecorded: async (t) => (t as unknown) === tx,
          isRefunded: async () => false,
          refund,
        }
      )
    ).resolves.toBe('recorded-elsewhere');
    expect(refund).not.toHaveBeenCalled();
  });

  it('does not refund twice', async () => {
    await refundUnlessRecorded(
      'the-key',
      { userId: 1 },
      {
        isRecorded: async () => false,
        isRefunded: async () => true,
        refund,
      }
    );
    expect(refund).not.toHaveBeenCalled();
  });

  it('a refund that fails is "may have gone through": the charge stays for a retry to record', async () => {
    await expect(
      refundUnlessRecorded(
        'the-key',
        { userId: 1 },
        {
          isRecorded: async () => false,
          isRefunded: async () => false,
          refund: async () => {
            throw new Error('buzz down');
          },
        }
      )
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
  });
});

// After a failed record, each refund attempt is its own short lock transaction that re-checks
// whether another request recorded the charge. One transaction held across the attempts (and their
// pauses) would outlast its deadline; a record check made once, before the loop, would refund a
// charge another request recorded between attempts.
describe('recordKeyedCharge refund attempts', () => {
  const KEY = 'refund-attempts-key';
  let locks = createFakeAdvisoryLocks();

  beforeEach(() => {
    locks = createFakeAdvisoryLocks();
    dbMock.dbWrite.$transaction.mockImplementation(((
      cb: (t: unknown) => Promise<unknown>,
      options?: { timeout?: number }
    ) => locks.transaction(cb, {}, options)) as never);
  });

  const run = (opts: {
    findRecorded: () => Promise<unknown>;
    refund: () => Promise<unknown>;
    refundAttempts: number;
  }) =>
    recordKeyedCharge(
      KEY,
      { userId: 1 },
      {
        findRecorded: opts.findRecorded,
        isRefunded: async () => false,
        record: async () => {
          throw new Error('write failed');
        },
        refund: opts.refund,
        refundAttempts: opts.refundAttempts,
      }
    );

  it('takes a new lock per attempt, re-checks the record each time, and holds no lock while pausing', async () => {
    // At each record check: transactions open, and locks taken so far.
    const checks: { open: number; taken: number }[] = [];
    // Sampled mid-pause: 100ms after a failed attempt, inside the shortest pause (250ms).
    const openMidPause: Promise<number>[] = [];
    const refund = vi.fn(async () => {
      if (refund.mock.calls.length < 3) {
        openMidPause.push(new Promise((resolve) => setTimeout(() => resolve(locks.open()), 100)));
        throw new Error('buzz down');
      }
    });

    await expect(
      run({
        findRecorded: async () => {
          checks.push({ open: locks.open(), taken: locks.taken().length });
          return null;
        },
        refund,
        refundAttempts: 3,
      })
    ).rejects.toThrow('write failed');

    // The record's own transaction, then one per refund attempt.
    expect(locks.taken()).toEqual([KEY, KEY, KEY, KEY]);
    expect(checks).toEqual([
      { open: 1, taken: 1 },
      { open: 1, taken: 2 },
      { open: 1, taken: 3 },
      { open: 1, taken: 4 },
    ]);
    expect(refund).toHaveBeenCalledTimes(3);
    expect(await Promise.all(openMidPause)).toEqual([0, 0]);
  });

  it('stops with nothing refunded when another request records the charge between attempts', async () => {
    let check = 0;
    const refund = vi.fn(async () => {
      throw new Error('buzz down');
    });

    await expect(
      run({
        // The record check, attempt 1: not recorded; attempt 2: recorded elsewhere.
        findRecorded: async () => (++check >= 3 ? { id: 1 } : null),
        refund,
        refundAttempts: 3,
      })
    ).rejects.toThrow('write failed');

    expect(check).toBe(3);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(locks.taken()).toEqual([KEY, KEY, KEY]);
  });
});

// The budget in buzz-charge-lock.ts, pinned: everything that can run under the lock ends before
// the transaction deadline releases it, with margin.
describe('the record lock budget', () => {
  it('the longest path under the lock fits inside the transaction deadline', () => {
    expect(CHARGE_LOCK_WAIT).toBe(`${CHARGE_LOCK_WAIT_MS / 1000}s`);
    expect(CHARGE_STATEMENT_TIMEOUT).toBe(`${CHARGE_STATEMENT_TIMEOUT_MS / 1000}s`);
    // One attempt each: a retry would multiply the deadline.
    expect(CHARGE_LOCKED_REFUND.retries).toBe(0);
    expect(CHARGE_LOCKED_READ.retries).toBe(0);

    const refundCheckReads = 2; // a donation: its prefix list, then its one leg's refund
    const worstCase =
      CHARGE_LOCK_WAIT_MS +
      CHARGE_STATEMENT_TIMEOUT_MS + // the record check
      refundCheckReads * CHARGE_LOCKED_READ.timeoutMs +
      CHARGE_LOCKED_REFUND.timeoutMs;
    expect(worstCase).toBe(31_000);
    expect(CHARGE_RECORD_TRANSACTION_TIMEOUT_MS - worstCase).toBeGreaterThanOrEqual(10_000);
  });
});

describe('recordStepError', () => {
  const context = { externalTransactionId: 'k', userId: 1 };

  it('passes a refusal through', () => {
    const refusal = new TRPCError({ code: 'BAD_REQUEST', message: 'already completed' });
    expect(recordStepError(refusal, context)).toBe(refusal);
  });

  it.each([
    [
      'a Prisma pool timeout',
      new Prisma.PrismaClientKnownRequestError('p', { code: 'P2024', clientVersion: 't' }),
    ],
    ['a server error', new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'x' })],
    ['a plain error', new Error('boom')],
  ])('turns %s into "may have gone through"', (_, error) => {
    expect(recordStepError(error, context)).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
  });
});
