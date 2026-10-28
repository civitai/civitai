/** Every number that shapes progression. The level curve itself lives in `@civitai/shared/new-order-levels`. */
export const PROGRESSION = {
  /** Flat XP paid the moment a vote is cast, whatever it is later graded as. */
  voteXp: 10,
  /** Bulk XP paid when a vote is graded correct. With voteXp, a correct vote is worth the old game's flat 100. */
  correctXp: 90,
  /** Gold a vote is worth before the rank multiplier. */
  baseGold: 100,
  /** Fervor looks at this many of the player's most recent graded votes. */
  fervorWindow: 500,
  /** Fervor paid per correct vote in the window before the accuracy factor. */
  fervorPerCorrect: 100,
  /** Accuracy never counts for less than this, so a poor streak does not zero fervor. */
  fervorAccuracyFloor: 0.1,
} as const;

export const RANK_GOLD_MULTIPLIER: Record<string, number> = {
  Knight: 1,
  Templar: 1.25,
  Paladin: 1.5,
};

/** Gold a vote cast by this rank is worth; it is pending until graded, then earned if correct. */
export const goldForRank = (rank: string): number =>
  Math.round(PROGRESSION.baseGold * (RANK_GOLD_MULTIPLIER[rank] ?? 1));
