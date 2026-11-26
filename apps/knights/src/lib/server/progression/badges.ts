import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { RANK_LADDER } from './config';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Rank badge Trophy cosmetics, keyed by hardcoded id since no table maps a rank to its cosmetic. Knight and Templar
 * match the main app's `newOrderConfig.cosmetics.badgeIds`; Paladin (4208) is not in it, as the original game has no
 * Paladin rank.
 */
export const RANK_BADGE_IDS = { Knight: 859, Templar: 860, Paladin: 4208 } as const;

/** The Acolyte badge (the main app's `newOrderConfig.cosmetics.badgeIds` Acolyte entry), granted on joining. */
export const ACOLYTE_BADGE_ID = 858;

const SAVEPOINT = sql`grant_trophy_cosmetics`;

/**
 * Gives the player the badge of `rank` and of every ladder rank below it that has one, so a Knight who skips to
 * Paladin still holds the Templar badge.
 */
export async function grantRankBadges(db: Executor, userId: number, rank: string): Promise<void> {
  const upTo = RANK_LADDER.findIndex((entry) => entry.rank === rank);
  const ids = RANK_LADDER.slice(0, upTo + 1).flatMap((entry) =>
    entry.rank in RANK_BADGE_IDS ? [RANK_BADGE_IDS[entry.rank as keyof typeof RANK_BADGE_IDS]] : []
  );
  await grantTrophyCosmetics(db, userId, ids);
}

/**
 * Like the original game's `awardTrophyCosmetic` it takes only a cosmetic that is a Trophy and skips one the player
 * already holds, so a repeat grants nothing. Best effort: it never throws, and inside a transaction a failed insert is
 * rolled back to a savepoint rather than poisoning the caller. Unlike the original it does not queue the user-search
 * reindex, and needs no cosmetic-cache refresh: that cache only holds equipped cosmetics, and a new badge is not
 * equipped.
 */
export async function grantTrophyCosmetics(
  db: Executor,
  userId: number,
  ids: number[]
): Promise<void> {
  if (ids.length === 0) return;
  const guard = db.isTransaction;
  try {
    if (guard) await sql`savepoint ${SAVEPOINT}`.execute(db);
    await sql`
      insert into "UserCosmetic" ("userId", "cosmeticId")
      select ${userId}::int, c."id" from "Cosmetic" c
      where c."id" in (${sql.join(ids)}) and c."source" = 'Trophy'
        and not exists (
          select 1 from "UserCosmetic" uc where uc."userId" = ${userId} and uc."cosmeticId" = c."id"
        )
      on conflict do nothing`.execute(db);
    if (guard) await sql`release savepoint ${SAVEPOINT}`.execute(db);
  } catch (error) {
    if (guard) await sql`rollback to savepoint ${SAVEPOINT}`.execute(db).catch(() => undefined);
    console.error('knights: could not grant the trophy cosmetics', { userId, ids, error });
  }
}
