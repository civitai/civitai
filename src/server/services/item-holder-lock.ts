import type { Prisma } from '@prisma/client';
import { ITEM_HOLDER_LOCK_CLASS, ITEM_HOLDER_LOCK_TIMEOUT } from '@civitai/shared/item-holder-lock';

export { ITEM_HOLDER_LOCK_CLASS };

/**
 * Shown when this user's lock is held by other work, or too many purchases and opens are in flight.
 */
export const ITEM_HOLDER_BUSY_MESSAGE =
  'Your last purchase or box opening is still processing. Try again in a moment.';

/**
 * Serialises everything that grants a cosmetic to one user or reads what they own to decide a
 * grant: shop purchases and mystery box opens. A box never draws something the buyer owns, and it
 * decides that from a read; without a shared lock a shelf purchase committing between that read
 * and the box's grant would hand over the same cosmetic twice.
 *
 * Mutual exclusion only between callers that take it, so every such grant path must. Call inside
 * the grant transaction; the lock is released when it ends.
 *
 * Gives up after `ITEM_HOLDER_LOCK_TIMEOUT` with `55P03` (`isPrismaLockTimeout`): Prisma's
 * transaction timeout does not cancel a waiting statement, and a waiter would otherwise hold its
 * connection and any rows it locked until the role's own `lock_timeout`, if it has one. The timeout
 * stays set for the rest of the transaction.
 */
export async function lockItemHolder(tx: Prisma.TransactionClient, userId: number) {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${ITEM_HOLDER_LOCK_TIMEOUT}, true)`;
  // Both arguments int4: Prisma binds a JS number as int8, and there is no (int4, int8) overload.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ITEM_HOLDER_LOCK_CLASS}::int, ${userId}::int)`;
}
