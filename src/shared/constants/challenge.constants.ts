// Policy constants for public (user-created) challenges. Kept in shared/ so both the
// server (validation/enforcement) and the client (form limits, previews) use one source.

/** Minimum User.meta.scores.total required to create a challenge (the existing
 * "high-reputation" tier — see post.schema.ts rate-limit rules). */
export const CHALLENGE_MIN_CREATOR_SCORE = 5000;

/** Buzz taken from each paid entry to cover AI judging + platform overhead. */
export const CHALLENGE_ENTRY_HOUSE_CUT = 25;

/** Minimum entry fee. Must exceed the house cut so at least
 * (CHALLENGE_MIN_ENTRY_FEE - CHALLENGE_ENTRY_HOUSE_CUT) buzz reaches the prize pool. */
export const CHALLENGE_MIN_ENTRY_FEE = 50;

/** Upper bound on entry fee (sanity ceiling; not a product limit). */
export const CHALLENGE_MAX_ENTRY_FEE = 100_000;

/** Max simultaneously Scheduled+Active user-created challenges, by membership tier.
 * (fib: free 1, bronze 2, silver 3, gold 5; founder treated as bronze.) */
export const CHALLENGE_TIER_ACTIVE_LIMITS: Record<string, number> = {
  free: 1,
  founder: 2,
  bronze: 2,
  silver: 3,
  gold: 5,
};

export const CHALLENGE_DEFAULT_ACTIVE_LIMIT = 1;

export function getChallengeActiveLimit(tier?: string | null): number {
  if (!tier) return CHALLENGE_DEFAULT_ACTIVE_LIMIT;
  return CHALLENGE_TIER_ACTIVE_LIMITS[tier] ?? CHALLENGE_DEFAULT_ACTIVE_LIMIT;
}

/** Net buzz a single paid entry contributes to the prize pool (never negative). */
export function getEntryPoolContribution(entryFee: number): number {
  return Math.max(0, entryFee - CHALLENGE_ENTRY_HOUSE_CUT);
}
