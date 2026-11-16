/** The original game's base smite size (`newOrderConfig.smiteSize`), also the size of its wrong-answer smite for Acolytes. */
export const BASE_SMITE_SIZE = 10;
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

/** The reason on a smite an Acolyte earns for wrong answers; it also marks where their wrong-answer count starts over. */
export const ACOLYTE_WRONG_ANSWER_SMITE = 'Acolyte - Too many wrong answers';
