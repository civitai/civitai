import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { calculateFervor, ledgerOf } from './progression/progression';
import {
  accuracyOf,
  nextLadderEntry,
  progressToward,
  standingOf,
  type Ledger,
  type Standing,
} from './progression/rating';
import { RATING } from './progression/config';

export type PlayerStatus = {
  rank: string;
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  progressPercent: number;
  fervor: number;
  goldPending: number;
  goldEarned: number;
  rating: Standing & { graded: number; minGraded: number };
  nextRank: {
    rank: string;
    fromLevel: number;
    accuracyBar: number;
    levelsToGo: number;
    levelMet: boolean;
    accuracyMet: boolean;
  } | null;
};

type Extras = { ledger?: Ledger; goldPending?: number; goldEarned?: number };

export function statusFrom(rank: string, exp: number, standing: Extras = {}): PlayerStatus {
  const progress = getLevelProgression(exp);
  const ledger = standing.ledger ?? { correct: 0, graded: 0 };
  const accuracy = accuracyOf(ledger);
  const next = nextLadderEntry(rank);
  return {
    rank,
    level: progress.level,
    xpIntoLevel: progress.xpIntoLevel,
    xpForNextLevel: progress.xpForNextLevel,
    progressPercent: progress.progressPercent,
    fervor: calculateFervor(ledger),
    goldPending: standing.goldPending ?? 0,
    goldEarned: standing.goldEarned ?? 0,
    rating: {
      graded: ledger.graded,
      minGraded: RATING.minGraded,
      ...standingOf(rank, ledger),
    },
    nextRank: next && {
      rank: next.rank,
      fromLevel: next.fromLevel,
      accuracyBar: next.accuracyBar,
      ...progressToward(next, progress.level, accuracy),
    },
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
    ? statusFrom(player.rankType, player.exp, { ...player, ledger: await ledgerOf(db, userId) })
    : null;
}

/** A player with no row yet is an Acolyte at level 1. */
export async function getPlayerStatusOrNew(db: Kysely<DB>, userId: number): Promise<PlayerStatus> {
  return (await getPlayerStatus(db, userId)) ?? statusFrom('Acolyte', 0);
}
