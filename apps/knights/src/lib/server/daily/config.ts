import { isRank, RANK_RULES } from '../ranks';

/** Days are UTC everywhere. The per-rank gold cap is `dailyGoldCap` in `ranks.ts`. */
export const DAILY = {
  /** Votes in one UTC day that make up the Daily Watch. */
  watchSize: 30,
  /** Paid as earned gold for a completed Watch, times the streak (capped by `streakCap`). */
  watchBonusGold: 100,
  streakCap: 7,
  /** One shield is granted per ISO week, up to this many held. */
  maxShields: 1,
} as const;

export const streakBonusGold = (streak: number): number =>
  DAILY.watchBonusGold * Math.min(streak, DAILY.streakCap);

/** 0 for a rank the table does not know. */
export const dailyGoldCapOf = (rank: string): number =>
  isRank(rank) ? RANK_RULES[rank].dailyGoldCap : 0;

/** The part of `gold` that still fits under the rank's daily cap. */
export const goldWithinCap = (rank: string, recorded: number, gold: number): number =>
  Math.max(0, Math.min(gold, dailyGoldCapOf(rank) - recorded));
