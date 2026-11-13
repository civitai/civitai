import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { paymentOutcomeUnknown } from '~/server/services/buzz-keyed-charge';
import { isPrismaLockTimeout } from '~/server/utils/errorHandling';

/**
 * Serialises what two requests with one client key do with ONE charge: record it once, and never
 * refund a charge the other recorded. The Buzz charge itself runs outside (the ledger dedupes it
 * by external id), so no database connection waits on the Buzz service except a refund after a
 * failed record (`refundUnlessRecorded`).
 *
 * A short primary transaction takes `pg_advisory_xact_lock(hashtextextended(<key>, 0))`, released
 * at commit or rollback. No table, no migration. Bounded: the lock wait (past it, "may have gone
 * through"), each statement under it, and the transaction.
 */
export const CHARGE_LOCK_WAIT = '10s';
export const CHARGE_STATEMENT_TIMEOUT = '5s';
export const CHARGE_RECORD_TRANSACTION_TIMEOUT_MS = 20_000;
/** A ledger read under the lock (the refund check). */
export const CHARGE_LOCKED_READ = { timeoutMs: 5_000, retries: 0 };
/** The one ledger write under the lock: a refund after a failed record. */
export const CHARGE_LOCKED_REFUND_TIMEOUT_MS = 15_000;

export async function withChargeKeyLock<T>(
  key: string,
  context: { userId: number; amount?: number },
  run: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  try {
    return await dbWrite.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${CHARGE_LOCK_WAIT}, true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        // The bound on the wait is for the lock only; the work under it gets a statement bound.
        await tx.$executeRaw`SET LOCAL lock_timeout TO DEFAULT`;
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${CHARGE_STATEMENT_TIMEOUT}, true)`;
        return run(tx);
      },
      { timeout: CHARGE_RECORD_TRANSACTION_TIMEOUT_MS }
    );
  } catch (error) {
    if (isPrismaLockTimeout(error))
      throw paymentOutcomeUnknown(
        { externalTransactionId: key, ...context },
        'another request with this key is in progress',
        { error }
      );
    throw error;
  }
}

/**
 * After a failed record: refunds the charge unless another request with the same key recorded it
 * meanwhile (that record owns the charge). Under the key's lock, so no request records on a charge
 * while it is being refunded. The refund is the one Buzz call made while holding a connection,
 * bounded by `CHARGE_LOCKED_REFUND_TIMEOUT_MS`, on this rare path only.
 *
 * Not refunding after commit instead ("mark, then refund") because there is nowhere to put the mark
 * without a migration: a refund started after the lock is released could reverse a charge a
 * concurrent request records in between.
 *
 * A refund that fails leaves the charge unrecorded and unrefunded, which a retry with the same key
 * continues from (it finds the charge and records it), so it is reported as "may have gone through".
 */
export async function refundUnlessRecorded(
  key: string,
  context: { userId: number; amount?: number },
  {
    isRecorded,
    isRefunded,
    refund,
  }: {
    isRecorded: (tx: Prisma.TransactionClient) => Promise<boolean>;
    isRefunded: () => Promise<boolean>;
    refund: () => Promise<unknown>;
  }
): Promise<'recorded-elsewhere' | 'refunded'> {
  try {
    return await withChargeKeyLock(key, context, async (tx) => {
      if (await isRecorded(tx)) return 'recorded-elsewhere';
      if (!(await isRefunded())) await refund();
      return 'refunded';
    });
  } catch (refundError) {
    throw paymentOutcomeUnknown(
      { externalTransactionId: key, ...context },
      'refund after a failed record did not complete',
      { error: refundError }
    );
  }
}
