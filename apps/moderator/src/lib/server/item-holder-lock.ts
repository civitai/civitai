import type { Transaction } from 'kysely';
import { sql } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { ITEM_HOLDER_LOCK_CLASS, ITEM_HOLDER_LOCK_TIMEOUT } from '@civitai/shared/item-holder-lock';

export const ITEM_HOLDER_BUSY_MESSAGE =
  'This user has a purchase, box opening or moderator change in progress. Try again in a moment.';

const LOCK_NOT_AVAILABLE = '55P03';

/**
 * The main app's `lockItemHolder`: serialises this user's cosmetic grants and take-backs with its shop
 * purchases and box opens. A box open decides what it may draw from what the user owns, so a grant
 * inside that window would hand them the same cosmetic twice. Call first inside the transaction; it is
 * released when that ends.
 *
 * The timeout stays set for the rest of the transaction.
 */
export async function lockItemHolder(trx: Transaction<DB>, userId: number) {
  await sql`SELECT set_config('lock_timeout', ${ITEM_HOLDER_LOCK_TIMEOUT}, true)`.execute(trx);
  // Both casts matter: there is no (int4, int8) overload.
  await sql`SELECT pg_advisory_xact_lock(${ITEM_HOLDER_LOCK_CLASS}::int, ${userId}::int)`.execute(
    trx
  );
}

/** A lock wait in a `lockItemHolder` transaction outlasted `ITEM_HOLDER_LOCK_TIMEOUT`. */
export function isItemHolderBusy(error: unknown) {
  return (error as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE;
}
