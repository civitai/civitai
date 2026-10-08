type UserMetaScores = { scores?: { total?: number } };

/**
 * The Creator Score, as the account Profile pane displays it — `User.meta.scores.total`, the sum of the six
 * per-category scores the nightly job writes.
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

const AGGREGATE_CATEGORIES = [
  'models',
  'articles',
  'images',
  'users',
  'reportsActioned',
  'reportsAgainst',
] as const;

type UserMetaCategoryScores = {
  scores?: Partial<Record<(typeof AGGREGATE_CATEGORIES)[number] | 'total', unknown>>;
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
  const sum = AGGREGATE_CATEGORIES.reduce((acc, key) => acc + finiteOr0(scores?.[key]), 0);
  return Math.max(sum, finiteOr0(scores?.total));
}
