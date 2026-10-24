type UserMetaScores = { scores?: { total?: number } };

/**
 * The Creator Score, as the account Profile pane displays it — `User.meta.scores.total`, the sum of the
 * per-category scores in `CREATOR_SCORE_CATEGORIES`.
 *
 * Read it through here rather than reaching for a per-category score. Every gate that says "creator
 * score" to the user has to mean the number the user can see, or the gate refuses people the account
 * page told were eligible: monetization and early access both keyed off `scores.models` until
 * 2026-09-04, and 45,216 accounts sat above the displayed floor and below the enforced one.
 *
 * Absent or malformed reads as 0, so every caller fails closed.
 */
export function creatorScoreFromMeta(meta: unknown): number {
  const score = (meta as UserMetaScores | null | undefined)?.scores?.total;
  return typeof score === 'number' && Number.isFinite(score) ? score : 0;
}

/** The session's Creator Score, or undefined when the session carries no scores at all (not zero). */
export function creatorScoreFromSession(user: { meta?: unknown } | null | undefined) {
  return (user?.meta as UserMetaScores | null | undefined)?.scores
    ? creatorScoreFromMeta(user?.meta)
    : undefined;
}

/**
 * Every per-category score `User.meta.scores.total` sums. A new one also goes in Creator Studio's
 * `SCORE_KEYS` (`apps/creator-studio/src/lib/server/creator-score.ts`); a parity test enforces it.
 */
export const CREATOR_SCORE_CATEGORIES = [
  'models',
  'articles',
  'images',
  'users',
  'reportsActioned',
  'reportsAgainst',
  'staffAwarded',
] as const;

/** SQL summing every category under `<meta>->'scores'`; an absent category reads as 0. */
export function creatorScoreCategorySumSql(meta: string) {
  return CREATOR_SCORE_CATEGORIES.map(
    (category) => `COALESCE((${meta}->'scores'->>'${category}')::numeric, 0)`
  ).join(' + ');
}

type UserMetaCategoryScores = {
  scores?: Partial<Record<(typeof CREATOR_SCORE_CATEGORIES)[number] | 'total', unknown>>;
};

const finiteOr0 = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * The score the Creator Program and announcement gates compare: the larger of the category sum and the
 * stored total. Mirrors the GREATEST in `getCreatorRequirements`; a category added to the nightly score
 * job has to be added to both.
 */
export function creatorAggregateScoreFromMeta(meta: unknown): number {
  const scores = (meta as UserMetaCategoryScores | null | undefined)?.scores;
  const sum = CREATOR_SCORE_CATEGORIES.reduce((acc, key) => acc + finiteOr0(scores?.[key]), 0);
  return Math.max(sum, finiteOr0(scores?.total));
}

/** The categories a public score split shows: positive points only, no reports or staff awards. */
export const CREATOR_SCORE_SPLIT_CATEGORIES = ['models', 'images', 'articles', 'users'] as const;

export type CreatorScoreSplit = Record<(typeof CREATOR_SCORE_SPLIT_CATEGORIES)[number], number>;

/**
 * Each split category's whole-percent share of their sum, the shares adding up to 100 (largest
 * remainder). Shares only, so the split cannot be multiplied back into a score. Null when no
 * category is positive.
 */
export function creatorScoreSplitFromMeta(meta: unknown): CreatorScoreSplit | null {
  const scores = (meta as UserMetaCategoryScores | null | undefined)?.scores;
  const values = CREATOR_SCORE_SPLIT_CATEGORIES.map((key) => Math.max(finiteOr0(scores?.[key]), 0));
  const pool = values.reduce((sum, value) => sum + value, 0);
  if (pool <= 0) return null;

  const exact = values.map((value) => (value / pool) * 100);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((sum, share) => sum + share, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - shares[index] }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    shares[index]++;
    left--;
  }
  return Object.fromEntries(
    CREATOR_SCORE_SPLIT_CATEGORIES.map((key, index) => [key, shares[index]])
  ) as CreatorScoreSplit;
}
