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

export const goldForRank = (rank: string): number =>
  Math.round(PROGRESSION.baseGold * (RANK_GOLD_MULTIPLIER[rank] ?? 1));
