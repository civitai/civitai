import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '@civitai/shared/new-order-levels';

export type PlayerStatus = {
  rank: string;
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  progressPercent: number;
};

export function statusFrom(rank: string, exp: number): PlayerStatus {
  const progress = getLevelProgression(exp);
  return {
    rank,
    level: progress.level,
    xpIntoLevel: progress.xpIntoLevel,
    xpForNextLevel: progress.xpForNextLevel,
    progressPercent: progress.progressPercent,
  };
}

export async function getPlayerStatus(
  db: Kysely<DB>,
  userId: number
): Promise<PlayerStatus | null> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp'])
    .where('userId', '=', userId)
    .executeTakeFirst();
  return player ? statusFrom(player.rankType, player.exp) : null;
}
