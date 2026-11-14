import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { dbWrite } from '~/server/db/client';
import {
  PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
  PAYMENT_REFUNDED_MESSAGE,
  paymentOutcomeUnknown,
} from '~/server/services/buzz-keyed-charge';
import { isPrismaLockTimeout, sleep, throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * Serialises what two requests with one client key do with ONE charge: record it once, and never
 * refund a charge the other recorded. The Buzz charge itself runs outside (the ledger dedupes it
 * by external id). Buzz calls do run while the lock's connection is held, each ledger read or write
 * one attempt with a deadline (the budget below): the refund-state check (`CHARGE_LOCKED_READ`) on
 * every keyed record, because refunds are serialised by this same lock and the check only holds
 * under it; and, after a failed record only, the refund itself (`CHARGE_LOCKED_REFUND`,
 * `refundUnlessRecorded`).
 *
 * A short primary transaction takes `pg_advisory_xact_lock(hashtextextended(<key>, 0))`, released
 * at commit or rollback. No table, no migration. Bounded: the lock wait (past it, "may have gone
 * through"), each statement under it, and the transaction.
 */
/**
 * The budget, in one place. Prisma rolls the transaction back at its deadline and that releases the
 * lock, so everything that can run under the lock must end before it, a refund call above all: a
 * lock released while a refund is still in flight lets a same-key request record on money that is
 * then refunded. Worst case under the lock (`refundUnlessRecorded`, the longest path):
 *
 *   lock wait                    10s  (lock_timeout)
 *   setup statements (3)          ~0s  (set_config / SET LOCAL; each also under the statement bound)
 *   the record check              5s  (statement_timeout)
 *   the refund check             2 x 3s (a prefix charge lists its prefix, then reads its one leg's
 *                                       refund: one leg, as a donation, an appeal fee and a crucible
 *                                       entry fee each charge one account type)
 *   the refund                   10s  (one attempt: `retries: 0`)
 *                               -----
 *                                31s  < 45s transaction deadline (14s margin)
 *
 * `buzz-charge-lock.test.ts` pins this sum.
 */
export const CHARGE_LOCK_WAIT = '10s';
export const CHARGE_LOCK_WAIT_MS = 10_000;
export const CHARGE_STATEMENT_TIMEOUT = '5s';
export const CHARGE_STATEMENT_TIMEOUT_MS = 5_000;
export const CHARGE_RECORD_TRANSACTION_TIMEOUT_MS = 45_000;
/** A ledger read under the lock (the refund check): one attempt. */
export const CHARGE_LOCKED_READ = { timeoutMs: 3_000, retries: 0 };
/**
 * The one ledger write under the lock, a refund after a failed record: ONE attempt with a deadline.
 * The client's default would retry it (refunds retry every failure), multiplying the deadline.
 */
export const CHARGE_LOCKED_REFUND = { timeoutMs: 10_000, retries: 0 };
/** Between refund attempts after a failed record (`recordKeyedCharge`'s `refundAttempts`), times the attempt. */
export const CHARGE_REFUND_RETRY_PAUSE_MS = 250;
/**
 * `recordKeyedCharge`'s `refundAttempts` for a record refusal the caller treats as routine (an
 * appeal already pending, a crucible past its entry cutoff): a retry of the action is refused before
 * it reaches the charge, so it cannot continue from one, and a single failed refund would leave the
 * fee charged for nothing.
 */
export const ROUTINE_REFUSAL_REFUND_ATTEMPTS = 3;

/**
 * After a charge succeeded, how an error from the record step reaches the user. A refusal (a 4xx:
 * already completed, refunded) is passed through. Anything else (no pooled connection, the
 * transaction failing to start or commit, a statement or lock timeout, a SET failing) says nothing
 * about whether the record was written, and the user has been charged: "may have gone through",
 * so the client keeps its key and a retry continues from the charge.
 */
export function recordStepError(
  error: unknown,
  context: { externalTransactionId: string; userId: number; amount?: number }
) {
  if (error instanceof TRPCError && getHTTPStatusCodeFromError(error) < 500) return error;
  // Already this answer (a lock wait past its bound): not wrapped twice.
  if (error instanceof TRPCError && error.message === PAYMENT_OUTCOME_UNKNOWN_MESSAGE) return error;
  return paymentOutcomeUnknown(context, 'record step failed after charging', { error });
}

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
 * while it is being refunded. The refund-state check and the refund both run under the lock and
 * end before the transaction deadline (see the budget above).
 * Refunding after release instead could reverse a charge a concurrent request records meanwhile.
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

/**
 * Records a keyed charge once, after `chargeByPrefix` / `chargeByExternalId` charged it OUTSIDE any
 * transaction. In a short transaction under the key's lock (`withChargeKeyLock`):
 * - already recorded by an earlier or concurrent request under the key: that record answers this
 *   request (`findRecorded` returns it), and nothing is written;
 * - refunded meanwhile (an earlier request failed its record and refunded the charge): refused
 *   with a 400, so the client starts a new action;
 * - otherwise `record` writes on the lock's transaction.
 *
 * `findRecorded` must return a non-null value for a recorded charge. `isRefunded` is a bounded
 * ledger read (`CHARGE_LOCKED_READ`) and throws "may have gone through" when it fails.
 *
 * A failed `record` refunds the charge under the same lock unless another request recorded it
 * (`refundUnlessRecorded`, `refund` bounded by `CHARGE_LOCKED_REFUND`), then throws
 * `recordFailed(error)` (the record's own error by default). `refundAttempts` (default 1) retries a
 * refund that failed, each attempt its own short lock transaction with a pause between them, never
 * one held across the attempts; for a refusal the caller treats as routine, where a retry of the
 * action is refused before it reaches the charge and so could not continue from it. When every
 * attempt fails: "may have gone through". Any other failure after the charge is
 * `recordStepError`: "may have gone through", with no refund.
 */
export async function recordKeyedCharge<T>(
  key: string,
  context: { userId: number; amount?: number },
  {
    findRecorded,
    isRefunded,
    record,
    refund,
    recordFailed = (error) => error,
    refundAttempts = 1,
  }: {
    findRecorded: (tx: Prisma.TransactionClient) => Promise<T | null | undefined>;
    isRefunded: () => Promise<boolean>;
    record: (tx: Prisma.TransactionClient) => Promise<T>;
    refund: () => Promise<unknown>;
    recordFailed?: (error: unknown) => unknown;
    refundAttempts?: number;
  }
): Promise<T> {
  let writeFailed = false;
  try {
    return await withChargeKeyLock(key, context, async (tx) => {
      const recorded = await findRecorded(tx);
      if (recorded != null) return recorded;
      if (await isRefunded()) throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);
      try {
        return await record(tx);
      } catch (error) {
        writeFailed = true;
        throw error;
      }
    });
  } catch (error) {
    if (!writeFailed) throw recordStepError(error, { externalTransactionId: key, ...context });
    for (let attempt = 1; ; attempt++) {
      try {
        await refundUnlessRecorded(key, context, {
          isRecorded: async (tx) => (await findRecorded(tx)) != null,
          isRefunded,
          refund,
        });
        break;
      } catch (refundError) {
        if (attempt >= refundAttempts) throw refundError;
        await sleep(CHARGE_REFUND_RETRY_PAUSE_MS * attempt);
      }
    }
    throw recordFailed(error);
  }
}
