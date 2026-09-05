type UserMetaScores = { scores?: { total?: number } };

/**
 * The Creator Score, as `/user/account` displays it — `User.meta.scores.total`, the sum of the six
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
