/** The original game's base smite size (`newOrderConfig.smiteSize`). */
const BASE_SMITE_SIZE = 10;
/** The original game sizes a sanity-check smite at this multiple of the base. */
const SANITY_CHECK_SMITE_FACTOR = 10;

/** Mirrors the original game's values, so both games agree on the shared `NewOrderSmite` table. */
export const SMITES = {
  max: 3,
  size: BASE_SMITE_SIZE * SANITY_CHECK_SMITE_FACTOR,
  expireAfterDays: 7,
  /** `givenById` of a penalty the game itself issues (the original game's system player). */
  systemGiverId: -1,
} as const;
