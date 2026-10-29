import { RANK_RULES, type Rank } from '../ranks';

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

/** What is left of today's gold cap after `recorded`, and the share of `gold` that fits in it. */
export const goldWithinCap = (rank: Rank, recorded: number, gold: number): number =>
  Math.max(0, Math.min(gold, RANK_RULES[rank].dailyGoldCap - recorded));
