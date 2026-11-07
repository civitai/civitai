import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getGoldBalance } from './conversion/balance';
import { getLevelProgression } from './progression/levels';
import { calculateFervor, fervorLedgerOf } from './progression/fervor';
import { daysPlayedOf, ledgerOf, pendingXpOf } from './progression/progression';
import {
  accuracyOf,
  nextLadderEntry,
  progressToward,
  standingOf,
  type Ledger,
  type Standing,
} from './progression/rating';
import { RATING } from './progression/config';
import { SMITES } from './smites/config';
import { activeSmiteCount } from './smites/smites.service';

export type PlayerStatus = {
  rank: string;
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  /** Bulk XP the player's unsettled votes will pay if they are graded correct; not yet in `xpIntoLevel`. */
  xpPending: number;
  progressPercent: number;
  fervor: number;
  goldPending: number;
  goldEarned: number;
  /** What the shop calls spendable: earned gold not yet spent or reserved, 0 while the player is held. */
  goldSpendable: number;
  /** Active smites, out of `maxSmites`; the player's hearts are what is left. */
  smites: number;
  maxSmites: number;
  rating: Standing & { graded: number; minGraded: number };
  nextRank: {
    rank: string;
    fromLevel: number;
    accuracyBar: number;
    levelsToGo: number;
    levelMet: boolean;
    accuracyMet: boolean;
    /** Days with a vote the rank asks for (0: none), how many the player has (read only when it asks), and the rest. */
    minDaysPlayed: number;
    daysPlayed: number;
    daysToGo: number;
    daysMet: boolean;
  } | null;
};

type Extras = {
  ledger?: Ledger;
  /** Votes cast in the fervor window (not the accuracy ledger). */
  fervorLedger?: Ledger;
  goldPending?: number;
  goldEarned?: number;
  goldSpendable?: number;
  xpPending?: number;
  smites?: number;
  daysPlayed?: number;
};

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
    xpPending: standing.xpPending ?? 0,
    progressPercent: progress.progressPercent,
    fervor: calculateFervor(standing.fervorLedger ?? { correct: 0, graded: 0 }),
    goldPending: standing.goldPending ?? 0,
    goldEarned: standing.goldEarned ?? 0,
    goldSpendable: standing.goldSpendable ?? 0,
    smites: standing.smites ?? 0,
    maxSmites: SMITES.max,
    rating: {
      graded: ledger.graded,
      minGraded: RATING.minGraded,
      ...standingOf(rank, ledger),
    },
    nextRank: next && {
      rank: next.rank,
      fromLevel: next.fromLevel,
      accuracyBar: next.accuracyBar,
      minDaysPlayed: next.minDaysPlayed,
      daysPlayed: standing.daysPlayed ?? 0,
      ...progressToward(next, progress.level, accuracy, standing.daysPlayed ?? 0),
    },
  };
}

export async function getPlayerStatus(
  db: Kysely<DB>,
  userId: number,
  now = new Date()
): Promise<PlayerStatus | null> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp', 'goldPending', 'goldEarned'])
    .where('userId', '=', userId)
    .executeTakeFirst();
  const next = player && nextLadderEntry(player.rankType);
  return player
    ? statusFrom(player.rankType, player.exp, {
        ...player,
        goldSpendable: (await getGoldBalance(db, userId)).convertible,
        daysPlayed: next && next.minDaysPlayed > 0 ? await daysPlayedOf(db, userId) : 0,
        ledger: await ledgerOf(db, userId),
        xpPending: await pendingXpOf(db, userId),
        fervorLedger: await fervorLedgerOf(db, userId, now),
        smites: await activeSmiteCount(db, userId),
      })
    : null;
}

/** A player with no row yet is an Acolyte at level 1. */
export async function getPlayerStatusOrNew(db: Kysely<DB>, userId: number): Promise<PlayerStatus> {
  return (await getPlayerStatus(db, userId)) ?? statusFrom('Acolyte', 0);
}
