/** Mirrors the original game's values, so both games agree on the shared `NewOrderSmite` table. */
export const SMITES = {
  max: 3,
  size: 100,
  expireAfterDays: 7,
  /** `givenById` of a penalty the game itself issues (the original game's system player). */
  systemGiverId: -1,
} as const;

/** The original game's wording; the career-reset notice finds the reset by it. */
export const RESET_REASON = 'Your New Order career has been reset due to excessive smites.';
