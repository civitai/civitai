import { sanitizeCategoryLabel } from '~/shared/constants/challenge.constants';

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

/** A challenge's creator-defined judging category. `weight` is a percentage and must total 100. */
export type JudgingCategory = { key: string; label: string; weight: number };

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
 * The fixed rubric as judging categories, so daily challenges and creator-defined challenges
 * run through one scoring path. Weights must stay in step with `DEFAULT_CATEGORY_ROWS` — the
 * rows seeded onto new challenges — or a seeded challenge would score differently from an
 * unseeded one (asserted in daily-challenge-scoring.test.ts).
 */
export const FIXED_JUDGING_CATEGORIES: JudgingCategory[] = [
  { key: 'theme', label: 'Theme', weight: SCORE_WEIGHTS.theme * 100 },
  { key: 'wittiness', label: 'Wittiness', weight: SCORE_WEIGHTS.wittiness * 100 },
  { key: 'humor', label: 'Humor', weight: SCORE_WEIGHTS.humor * 100 },
  { key: 'aesthetic', label: 'Aesthetic', weight: SCORE_WEIGHTS.aesthetic * 100 },
];

/**
 * Weighted score for an entry judged against the fixed daily rubric, applying the theme gate:
 * - Theme < THEME_DISQUALIFY_THRESHOLD → null (auto-disqualified)
 * - Theme < THEME_GATE_THRESHOLD → capped at THEME_GATE_MAX_SCORE
 */
export function calculateWeightedScore(score: Score): number | null {
  return calculateWeightedCategoryScore(score, FIXED_JUDGING_CATEGORIES);
}

/**
 * Ranking score for user-created challenges, which use arbitrary creator-defined judging
 * categories instead of the fixed theme/aesthetic/humor/wittiness set. Every category is
 * weighted equally: the final score is the mean of the category scores (0-10). Categories
 * are clamped to 0-10 defensively (the LLM output is not trusted). Returns null if there are
 * no category scores to average.
 */
export function calculateCategoryScore(scores: Record<string, number>): number | null {
  const values = Object.values(scores).filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (values.length === 0) return null;
  const clamped = values.map((v) => Math.min(10, Math.max(0, v)));
  return clamped.reduce((a, b) => a + b, 0) / clamped.length;
}

const clampScore = (v: number) => Math.min(10, Math.max(0, Number(v) || 0));

/**
 * Read one category's score out of an AI review result. The review echoes category labels back
 * as JSON keys, so normalize both sides — minor case/whitespace drift from the LLM must not read
 * back as a 0 (which would disqualify every entry via the theme gate).
 */
export function lookupCategoryScore(scores: Record<string, number>, label: string): number {
  const target = sanitizeCategoryLabel(label).toLowerCase();
  for (const [key, value] of Object.entries(scores)) {
    if (sanitizeCategoryLabel(key).toLowerCase() === target) return clampScore(value);
  }
  return 0;
}

/**
 * Ranking score for user-created challenges with weighted, creator-defined categories.
 * Scores are keyed by category LABEL (the key the AI review schema emits). Theme is mandatory,
 * so its gate rules always apply: theme <= disqualify → null; theme < gate → cap.
 */
export function calculateWeightedCategoryScore(
  scores: Record<string, number>,
  categories: JudgingCategory[]
): number | null {
  const scoreFor = (label: string) => lookupCategoryScore(scores, label);

  const theme = categories.find((c) => c.key === 'theme');
  const themeScore = theme ? scoreFor(theme.label) : undefined;
  if (themeScore !== undefined && themeScore < THEME_DISQUALIFY_THRESHOLD) return null;
  const weighted = categories.reduce((sum, c) => sum + scoreFor(c.label) * (c.weight / 100), 0);
  if (themeScore !== undefined && themeScore < THEME_GATE_THRESHOLD)
    return Math.min(weighted, THEME_GATE_MAX_SCORE);
  return weighted;
}

const FIXED_SCORE_KEYS = ['theme', 'wittiness', 'humor', 'aesthetic'] as const;

/** True when a review result uses the fixed daily key set rather than creator-defined labels. */
export function isFixedJudgeScore(score: Score | Record<string, number>): score is Score {
  return FIXED_SCORE_KEYS.every((key) => typeof score[key] === 'number');
}

/**
 * The score shown next to an entry. Must stay identical to how `getJudgedEntries` ranks that
 * same entry, or the displayed leaderboard contradicts who actually wins.
 */
export function resolveDisplayScore(
  score: Score | Record<string, number>,
  categories?: JudgingCategory[] | null
): number | null {
  if (categories?.length) return calculateWeightedCategoryScore(score, categories);
  if (isFixedJudgeScore(score)) return calculateWeightedScore(score);
  return calculateCategoryScore(score);
}
