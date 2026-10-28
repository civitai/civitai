import { RANK_RULES, type Rank } from '../ranks';

/** The level curve lives in @civitai/shared/new-order-levels. */
export const PROGRESSION = {
  voteXp: 10,
  /** voteXp + correctXp must stay 100, the original game's per-correct-vote XP. */
  correctXp: 90,
  baseGold: 100,
  fervorWindow: 500,
  fervorPerCorrect: 100,
  fervorAccuracyFloor: 0.1,
} as const;

/** Acolyte (Trials) and Inquisitor (moderators) are deliberately not on the ladder. */
export const RANK_LADDER = [
  { rank: 'Knight', fromLevel: 1, accuracyBar: 0.7 },
  { rank: 'Templar', fromLevel: 21, accuracyBar: 0.8 },
  { rank: 'Paladin', fromLevel: 41, accuracyBar: 0.85 },
] as const satisfies readonly { rank: Rank; fromLevel: number; accuracyBar: number }[];

/** Accuracy is over the same last `PROGRESSION.fervorWindow` graded votes as fervor. */
export const RATING = {
  minGraded: 50,
  belowBarFactor: 0.5,
} as const;

/** Vote weight and gold are both scaled by this while a rated player is below their own rank's bar. */
export const penaltyFactor = (belowBar: boolean): number => (belowBar ? RATING.belowBarFactor : 1);

export const goldForRank = (rank: Rank, belowBar = false): number =>
  Math.round(PROGRESSION.baseGold * RANK_RULES[rank].goldMultiplier * penaltyFactor(belowBar));
