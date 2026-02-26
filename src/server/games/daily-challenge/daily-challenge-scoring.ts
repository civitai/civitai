/**
 * Pure scoring utilities for daily challenges.
 * This module has NO server dependencies (no Redis, Prisma, etc.)
 * so it can be safely imported from client-side components.
 */

export type Score = {
  theme: number; // 0-10 how well it fits the theme
  wittiness: number; // 0-10 how witty it is
  humor: number; // 0-10 how funny it is
  aesthetic: number; // 0-10 how aesthetically pleasing it is
};

/** Alias for Score — used in client-facing contexts (image cards, winner displays). */
export type JudgeScore = Score;

/** Weights for combining score categories into a final ranking score (must sum to 1.0). */
export const SCORE_WEIGHTS = {
  theme: 0.5,
  aesthetic: 0.2,
  humor: 0.15,
  wittiness: 0.15,
} as const;

/** Theme score at or below this threshold results in auto-disqualification. */
export const THEME_DISQUALIFY_THRESHOLD = 2;
/** Theme score below this threshold caps the final weighted score at THEME_GATE_MAX_SCORE. */
export const THEME_GATE_THRESHOLD = 4;
/** Maximum final score when theme is below the gate threshold. */
export const THEME_GATE_MAX_SCORE = 5.0;

/**
 * Calculates the weighted score for a challenge entry, applying the theme gate rules:
 * - Theme < THEME_DISQUALIFY_THRESHOLD → returns null (auto-disqualified)
 * - Theme < THEME_GATE_THRESHOLD → weighted score capped at THEME_GATE_MAX_SCORE
 * - Otherwise → weighted score (0-10 range)
 */
export function calculateWeightedScore(score: Score): number | null {
  if (score.theme < THEME_DISQUALIFY_THRESHOLD) return null;

  const weighted =
    score.theme * SCORE_WEIGHTS.theme +
    score.aesthetic * SCORE_WEIGHTS.aesthetic +
    score.humor * SCORE_WEIGHTS.humor +
    score.wittiness * SCORE_WEIGHTS.wittiness;

  if (score.theme < THEME_GATE_THRESHOLD) {
    return Math.min(weighted, THEME_GATE_MAX_SCORE);
  }

  return weighted;
}
