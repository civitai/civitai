import type { Transaction } from 'kysely';
import { sql } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { ITEM_HOLDER_LOCK_CLASS, ITEM_HOLDER_LOCK_TIMEOUT } from '@civitai/shared/item-holder-lock';

/** What a moderator sees when the user's own purchase or box open holds their lock. */
export const ITEM_HOLDER_BUSY_MESSAGE =
  'This user has a purchase or box opening in progress. Try again in a moment.';

/**
 * The main app's `lockItemHolder`: serialises this user's cosmetic grants and take-backs with its shop
 * purchases and box opens. A box open decides what it may draw from what the user owns, so a grant
 * inside that window would hand them the same cosmetic twice. Call first inside the transaction; it is
 * released when that ends.
 *
 * Like the main app's, waits at most `ITEM_HOLDER_LOCK_TIMEOUT` (then `isItemHolderBusy`); the timeout
 * stays set for the rest of the transaction.
 */
export async function lockItemHolder(trx: Transaction<DB>, userId: number) {
  await sql`SELECT set_config('lock_timeout', ${ITEM_HOLDER_LOCK_TIMEOUT}, true)`.execute(trx);
  // Both casts matter: there is no (int4, int8) overload.
  await sql`SELECT pg_advisory_xact_lock(${ITEM_HOLDER_LOCK_CLASS}::int, ${userId}::int)`.execute(
    trx
  );
}

/** Postgres `55P03` (lock_not_available): a lock wait in a `lockItemHolder` transaction timed out. */
export function isItemHolderBusy(error: unknown) {
  return (error as { code?: unknown } | null)?.code === '55P03';
}
