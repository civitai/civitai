import type { Transaction } from 'kysely';
import { sql } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { ITEM_HOLDER_LOCK_CLASS } from '@civitai/shared/item-holder-lock';

/**
 * The main app's `lockItemHolder`: serialises this user's cosmetic grants and take-backs with its shop
 * purchases and box opens. A box open decides what it may draw from what the user owns, so a grant
 * inside that window would hand them the same cosmetic twice. Call first inside the transaction; it is
 * released when that ends.
 */
export async function lockItemHolder(trx: Transaction<DB>, userId: number) {
  // Both casts matter: there is no (int4, int8) overload.
  await sql`SELECT pg_advisory_xact_lock(${ITEM_HOLDER_LOCK_CLASS}::int, ${userId}::int)`.execute(
    trx
  );
}
