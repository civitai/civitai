import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { metrics } from './metrics';
import { ACOLYTE_BADGE_ID, grantTrophyCosmetics } from './progression/badges';

/**
 * Swears a user in as an Acolyte and grants the Acolyte badge, as the main app's `joinGame` did. A user who already
 * has a player row keeps it unchanged and gets no badge (v1 players received it when they joined there).
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
  if (joined) {
    metrics.join(userId);
    await grantTrophyCosmetics(db, userId, [ACOLYTE_BADGE_ID]);
  }
  return { joined };
}
