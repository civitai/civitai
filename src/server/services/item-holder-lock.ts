import type { Prisma } from '@prisma/client';
import { ITEM_HOLDER_LOCK_CLASS } from '@civitai/shared/item-holder-lock';

export { ITEM_HOLDER_LOCK_CLASS };

/**
 * Serialises everything that grants a cosmetic to one user or reads what they own to decide a
 * grant: shop purchases and mystery box opens. A box never draws something the buyer owns, and it
 * decides that from a read; without a shared lock a shelf purchase committing between that read
 * and the box's grant would hand over the same cosmetic twice.
 *
 * Mutual exclusion only between callers that take it, so every such grant path must. Call inside
 * the grant transaction; the lock is released when it ends.
 */
export async function lockItemHolder(tx: Prisma.TransactionClient, userId: number) {
  // Both arguments int4: Prisma binds a JS number as int8, and there is no (int4, int8) overload.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ITEM_HOLDER_LOCK_CLASS}::int, ${userId}::int)`;
}
