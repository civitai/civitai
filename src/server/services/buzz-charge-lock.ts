import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { paymentOutcomeUnknown } from '~/server/services/buzz-keyed-charge';
import { isPrismaLockTimeout } from '~/server/utils/errorHandling';

/**
 * One keyed charge at a time per key.
 *
 * Two requests can carry the same client key at once: a write hangs, the edge gives the client a
 * timeout while the first request is still running, and the client retries. Both would see the one
 * charge and both would record against it (two listings, two donations, doubled tip effects), and
 * the first one's refund on failure could reverse the charge the second recorded.
 *
 * So a keyed charge runs inside a primary transaction that first takes a transaction-scoped
 * advisory lock on the charge's external id (or prefix). The charge, the record written through
 * `tx`, and any refund after a failed record all happen under it; the lock is released when the
 * transaction ends, on every path. A second request with the same key waits, then sees what the
 * first did.
 *
 * No table and no migration: the lock is `pg_advisory_xact_lock` on a 64-bit hash of the key
 * (`hashtextextended`). Single-key advisory locks do not overlap the two-key ones other callers in
 * this repo take (`lockItemHolder`).
 *
 * Bounded everywhere, because this holds a pooled connection:
 * - the wait for the lock is `CHARGE_LOCK_WAIT`; past it the request is told the payment may have
 *   gone through (the other request may be charging), and its client keeps the key;
 * - every Buzz write under the lock takes `CHARGE_WRITE_TIMEOUT_MS`, so a hung write ends before
 *   the transaction does and the lock is not released while that request is still deciding;
 * - the transaction itself times out at `CHARGE_TRANSACTION_TIMEOUT_MS`, above the worst case of a
 *   charge, its resend and a refund.
 */
export const CHARGE_LOCK_WAIT = '10s';
export const CHARGE_WRITE_TIMEOUT_MS = 15_000;
export const CHARGE_TRANSACTION_TIMEOUT_MS = 60_000;

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
        // Back to the session's default for the work under the lock: its own row locks (a
        // creator's lock, a shop item's) keep the waits they had outside this helper.
        await tx.$executeRaw`SET LOCAL lock_timeout TO DEFAULT`;
        return run(tx);
      },
      { timeout: CHARGE_TRANSACTION_TIMEOUT_MS }
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
