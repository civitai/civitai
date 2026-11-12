import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { metrics } from './metrics';

/**
 * Swears a user in as an Acolyte. A user who already has a player row keeps it unchanged.
 * Reference: `joinGame` in the main app's `src/server/services/games/new-order.service.ts`, which also
 * awards the Acolyte badge cosmetic; that part is not ported yet.
 */
export async function joinOrder(
  db: Kysely<DB> | Transaction<DB>,
  userId: number
): Promise<{ joined: boolean }> {
  const result = await db
    .insertInto('NewOrderPlayer')
    .values({ userId, rankType: 'Acolyte' })
    .onConflict((oc) => oc.column('userId').doNothing())
    .executeTakeFirst();
  const joined = Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  if (joined) metrics.join(userId);
  return { joined };
}
