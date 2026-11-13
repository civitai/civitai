import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { refundUnlessRecorded, withChargeKeyLock } from '~/server/services/buzz-charge-lock';

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
      timeout: 20_000,
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
