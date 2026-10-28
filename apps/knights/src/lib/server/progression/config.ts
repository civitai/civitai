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

export const RANK_GOLD_MULTIPLIER: Record<string, number> = {
  Knight: 1,
  Templar: 1.25,
  Paladin: 1.5,
};

/** Each rank runs from `fromLevel` to the level before the next one's (Paladin has no cap). Acolyte (Trials) and Inquisitor (moderators) are not on the ladder. */
export const RANK_LADDER = [
  { rank: 'Knight', fromLevel: 1, accuracyBar: 0.7 },
  { rank: 'Templar', fromLevel: 21, accuracyBar: 0.8 },
  { rank: 'Paladin', fromLevel: 41, accuracyBar: 0.85 },
] as const;

/** Accuracy is over the same last `PROGRESSION.fervorWindow` graded votes as fervor. */
export const RATING = {
  minGraded: 50,
  /** Applied to vote weight and gold while a rated player is below their own rank's bar. */
  belowBarFactor: 0.5,
} as const;

export const goldForRank = (rank: string, belowBar = false): number =>
  Math.round(
    PROGRESSION.baseGold *
      (RANK_GOLD_MULTIPLIER[rank] ?? 1) *
      (belowBar ? RATING.belowBarFactor : 1)
  );
