/** The original game's base smite size (`newOrderConfig.smiteSize`), also the size of its wrong-answer smite for Acolytes. */
export const BASE_SMITE_SIZE = 10;
/**
 * Correct verdicts that work off a skill-check smite. The original game used 100 (10x the base); at a 30-image Watch that made a
 * lost heart last days, so v2 uses about one Watch.
 */
const SKILL_CHECK_SMITE_SIZE = 25;

/** Shared with the original game's `NewOrderSmite` table: the limit and expiry match it; the skill-check size is v2's own. */
export const SMITES = {
  max: 3,
  size: SKILL_CHECK_SMITE_SIZE,
  expireAfterDays: 7,
  /** `givenById` of a penalty the game itself issues (the original game's system player). */
  systemGiverId: -1,
} as const;

/** The reason on a smite an Acolyte earns for wrong answers; it also marks where their wrong-answer count starts over. */
export const ACOLYTE_WRONG_ANSWER_SMITE = 'Acolyte - Too many wrong answers';
