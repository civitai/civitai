import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { fervorOf } from './progression/progression';

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
    .select(['rankType', 'exp', 'goldPending', 'goldEarned'])
    .where('userId', '=', userId)
    .executeTakeFirst();
  return player
    ? statusFrom(player.rankType, player.exp, { ...player, fervor: await fervorOf(db, userId) })
    : null;
}

/** A player with no row yet is an Acolyte at level 1. */
export async function getPlayerStatusOrNew(db: Kysely<DB>, userId: number): Promise<PlayerStatus> {
  return (await getPlayerStatus(db, userId)) ?? statusFrom('Acolyte', 0);
}
