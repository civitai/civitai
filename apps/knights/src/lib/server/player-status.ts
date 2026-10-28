import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '@civitai/shared/new-order-levels';

export type PlayerStatus = {
  rank: string;
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  progressPercent: number;
  fervor: number;
  goldPending: number;
  goldEarned: number;
};

type Standing = { fervor?: number; goldPending?: number; goldEarned?: number };

export function statusFrom(rank: string, exp: number, standing: Standing = {}): PlayerStatus {
  const progress = getLevelProgression(exp);
  return {
    rank,
    level: progress.level,
    xpIntoLevel: progress.xpIntoLevel,
    xpForNextLevel: progress.xpForNextLevel,
    progressPercent: progress.progressPercent,
    fervor: standing.fervor ?? 0,
    goldPending: standing.goldPending ?? 0,
    goldEarned: standing.goldEarned ?? 0,
  };
}

export async function getPlayerStatus(
  db: Kysely<DB>,
  userId: number
): Promise<PlayerStatus | null> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp', 'fervor', 'goldPending', 'goldEarned'])
    .where('userId', '=', userId)
    .executeTakeFirst();
  return player ? statusFrom(player.rankType, player.exp, player) : null;
}
