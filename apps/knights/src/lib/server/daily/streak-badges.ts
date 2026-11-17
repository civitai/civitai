import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { grantTrophyCosmetics } from '../progression/badges';

type Executor = Kysely<DB> | Transaction<DB>;

export type StreakMilestone = 7 | 30 | 100;

/** Watch-streak badge Trophy cosmetics (Vigil 7, 30 and 100 days). A null id is skipped. */
export const STREAK_BADGE_IDS: Record<StreakMilestone, number | null> = {
  7: 4213,
  30: 4214,
  100: 4215,
};

/**
 * Grants the badge of every milestone `streak` has reached, so a player already past a milestone when its id is
 * filled in earns it on their next Watch. A badge the player already holds is skipped, so it is earned once ever.
 */
export async function grantStreakBadges(
  db: Executor,
  userId: number,
  streak: number,
  ids: Record<StreakMilestone, number | null> = STREAK_BADGE_IDS
): Promise<void> {
  const due = Object.entries(ids).flatMap(([milestone, id]) =>
    id !== null && Number(milestone) <= streak ? [id] : []
  );
  await grantTrophyCosmetics(db, userId, due);
}
