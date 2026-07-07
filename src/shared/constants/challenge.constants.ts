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

/** Upper bound on the creator's optional initial prize (escrowed at creation). */
export const CHALLENGE_MAX_INITIAL_PRIZE = 10_000_000;

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

// The label a category is scored under becomes a JSON key in the AI review schema; it must be
// stable across the write, the AI prompt, and the ranking lookup. Normalize once at write time.
export const sanitizeCategoryLabel = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim();

export const CHALLENGE_CATEGORY_KEYS = ['theme', 'humor', 'wittiness', 'aesthetic', 'custom'] as const;
export type ChallengeCategoryKey = (typeof CHALLENGE_CATEGORY_KEYS)[number];

// Preset judging categories offered in the public challenge form. Each carries the criteria the
// AI judge scores against. `theme` is mandatory (see the schema refine) and its gate always applies.
export const CHALLENGE_PRESET_CATEGORIES: Record<
  Exclude<ChallengeCategoryKey, 'custom'>,
  { label: string; criteria: string }
> = {
  theme: { label: 'Theme', criteria: 'How well the entry fits the challenge theme.' },
  humor: { label: 'Humor', criteria: 'How funny or amusing the entry is.' },
  wittiness: { label: 'Wittiness', criteria: 'Cleverness and wit of the concept.' },
  aesthetic: { label: 'Aesthetic', criteria: 'Overall visual quality and craft of the image.' },
};

// Judges a public-challenge creator may pick. Keyed on NAME (env-stable; excludes "CivChan NSFW",
// which shares CivChan's userId — public challenges are SFW-only).
export const USER_SELECTABLE_JUDGE_NAMES = ['CivBot', 'CivChan'] as const;
