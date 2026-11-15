import { RANK_LADDER } from '../progression/config';
import { isRank, RANK_RULES } from '../ranks';

/** Days are UTC everywhere. */
export const DAILY = {
  /** Votes in one UTC day that make up the Daily Watch. */
  watchSize: 30,
  /** Paid as earned gold for a completed Watch, times the streak (capped by `streakCap`). */
  watchBonusGold: 2000,
  streakCap: 7,
  /** One shield is granted per ISO week, up to this many held. */
  maxShields: 1,
} as const;

export const streakBonusGold = (streak: number): number =>
  DAILY.watchBonusGold * Math.min(streak, DAILY.streakCap);

/** The daily gold cap rises with level, not rank: a player uses the row for the highest level at or below theirs. */
export const DAILY_GOLD_CAP_BY_LEVEL = [
  { fromLevel: 20, gold: 80_000 },
  { fromLevel: 30, gold: 100_000 },
  { fromLevel: 40, gold: 120_000 },
  { fromLevel: 50, gold: 140_000 },
  { fromLevel: 60, gold: 160_000 },
  { fromLevel: 70, gold: 170_000 },
  { fromLevel: 80, gold: 180_000 },
  { fromLevel: 90, gold: 200_000 },
  { fromLevel: 100, gold: 250_000 },
  { fromLevel: 110, gold: 300_000 },
  { fromLevel: 120, gold: 350_000 },
  { fromLevel: 130, gold: 400_000 },
] as const;

/** 0 below level 20. */
export const dailyGoldCapOf = (level: number): number =>
  DAILY_GOLD_CAP_BY_LEVEL.findLast((row) => level >= row.fromLevel)?.gold ?? 0;

/**
 * The cap a player of this rank and level gets: 0 for a rank that earns no gold, and never below the rank's own first
 * level, so a Knight whose XP fell under level 20 (smites take XP) still has the Knight cap.
 */
export const dailyGoldCapFor = (rank: string, level: number): number => {
  if (!isRank(rank) || RANK_RULES[rank].goldMultiplier === 0) return 0;
  const fromLevel = RANK_LADDER.find((entry) => entry.rank === rank)?.fromLevel ?? 0;
  return dailyGoldCapOf(Math.max(level, fromLevel));
};

/** The part of `gold` that still fits under `cap`. `recorded` counts gold at vote time, so gold later forfeited by a wrong vote still counts against the day. */
export const goldWithinCap = (cap: number, recorded: number, gold: number): number =>
  Math.max(0, Math.min(gold, cap - recorded));
