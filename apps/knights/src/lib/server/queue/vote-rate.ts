import type { Kysely, Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';

export type VoteLimit = { windowSeconds: number; max: number };

/** A player may cast at most `max` votes in any trailing `windowSeconds`; the tightest window decides. */
export const VOTE_LIMITS: readonly VoteLimit[] = [
  { windowSeconds: 60, max: 40 },
  { windowSeconds: 3600, max: 600 },
  { windowSeconds: 86400, max: 3000 },
];

/** When the player may vote again, or null if they may now. Derived from the vote ledger, so it needs no state and survives a restart. */
export async function voteLockUntil(
  db: Kysely<DB> | Transaction<DB>,
  playerId: number,
  now: Date,
  limits: readonly VoteLimit[]
): Promise<Date | null> {
  const ends = await Promise.all(
    limits.map(async ({ windowSeconds, max }) => {
      const since = new Date(now.getTime() - windowSeconds * 1000);
      const filling = await db
        .selectFrom('KnightsVote')
        .select('createdAt')
        .where('playerId', '=', playerId)
        .where('createdAt', '>', utc(since))
        .orderBy('createdAt', 'desc')
        .offset(max - 1)
        .limit(1)
        .executeTakeFirst();
      return filling ? new Date(filling.createdAt.getTime() + windowSeconds * 1000) : null;
    })
  );
  return ends.reduce<Date | null>(
    (latest, end) => (end && (!latest || end > latest) ? end : latest),
    null
  );
}
