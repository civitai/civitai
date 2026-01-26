/**
 * Crucible feature constants
 * These constants define limits and configuration for the Crucible feature
 */

/**
 * Maximum entry fee in Buzz that can be charged for joining a crucible.
 * Set to 1M Buzz to prevent integer overflow in prize pool calculations.
 */
export const CRUCIBLE_MAX_ENTRY_FEE = 1_000_000;

/**
 * Maximum number of entries per user per crucible.
 * Set to 10K to prevent abuse and ensure fair competition.
 */
export const CRUCIBLE_MAX_ENTRIES = 10_000;

/**
 * Cost in Buzz for each crucible duration option.
 * Keys are duration in hours.
 */
export const CRUCIBLE_DURATION_COSTS: Record<number, number> = {
  8: 0, // 8 hours - free
  24: 500, // 24 hours
  72: 1000, // 3 days
  168: 2000, // 7 days
};

/**
 * Cost in Buzz for customizing the prize distribution.
 * This fee is charged when the crucible creator changes the default prize percentages.
 */
export const CRUCIBLE_PRIZE_CUSTOMIZATION_COST = 1000;
