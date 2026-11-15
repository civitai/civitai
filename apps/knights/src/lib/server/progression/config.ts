import { RANK_RULES, type Rank } from '../ranks';

/** The level curve is `levels.ts`. */
export const PROGRESSION = {
  voteXp: 10,
  /** voteXp + correctXp must stay 100, the original game's per-correct-vote XP. */
  correctXp: 90,
  baseGold: 100,
  /** Per Acolyte level, once per player. */
  acolyteLevelGold: 2000,
  /** Accuracy (and so rank) is over this many graded votes; it never decays with time. */
  accuracyWindow: 500,
  /** Fervor counts votes cast in this many days (by createdAt), with no cap. */
  fervorWindowDays: 7,
  /** Presentation only: scales every player's fervor alike, so it never changes the order. */
  fervorScale: 100,
  fervorAccuracyFloor: 0.1,
} as const;

/**
 * Acolyte (apprenticeship, levels 1-20) and Inquisitor (moderators) are deliberately not on the ladder. A rank needs
 * its level, its accuracy bar and `minDaysPlayed` distinct UTC days with a vote since the career began.
 */
export const RANK_LADDER = [
  { rank: 'Knight', fromLevel: 20, accuracyBar: 0.7, minDaysPlayed: 0 },
  { rank: 'Templar', fromLevel: 50, accuracyBar: 0.8, minDaysPlayed: 0 },
  { rank: 'Paladin', fromLevel: 90, accuracyBar: 0.85, minDaysPlayed: 60 },
] as const satisfies readonly {
  rank: Rank;
  fromLevel: number;
  accuracyBar: number;
  minDaysPlayed: number;
}[];

/** Accuracy is over the last `PROGRESSION.accuracyWindow` graded votes. */
export const RATING = {
  minGraded: 50,
  belowBarFactor: 0.5,
} as const;

/** Vote weight and gold are both scaled by this while a rated player is below their own rank's bar. */
export const penaltyFactor = (belowBar: boolean): number => (belowBar ? RATING.belowBarFactor : 1);

export const goldForRank = (rank: Rank, belowBar = false): number =>
  Math.round(PROGRESSION.baseGold * RANK_RULES[rank].goldMultiplier * penaltyFactor(belowBar));
