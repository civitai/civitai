import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export const RECENT_CONVERSIONS_LIMIT = 10;

export type RecentConversion = {
  id: number;
  gold: number;
  buzz: number;
  /** The stored status: `pending` (Buzz has not confirmed), `paid` or `failed`. */
  status: string;
  at: Date;
};

/** The player's latest conversions, newest first. Served by `KnightsGoldConversion_playerId_createdAt_idx`. */
export async function listRecentConversions(
  db: Kysely<DB>,
  playerId: number
): Promise<RecentConversion[]> {
  const rows = await db
    .selectFrom('KnightsGoldConversion')
    .select(['id', 'gold', 'buzz', 'status', 'createdAt'])
    .where('playerId', '=', playerId)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(RECENT_CONVERSIONS_LIMIT)
    .execute();
  return rows.map(({ createdAt, ...row }) => ({ ...row, at: createdAt }));
}
