import { describe, it, expect, vi } from 'vitest';

// Verifies `resolveChallengeReviewInputs` — the category+nsfw resolution extracted out of
// reviewEntriesForChallenge (~/server/jobs/daily-challenge-processing.ts) so the mod re-review
// endpoint (~/pages/api/mod/daily-challenge/re-review.ts) can mirror it exactly. Any challenge
// with a valid judgingCategories value is judged by it regardless of source; a malformed/null
// value falls back to `categories: undefined` (fixed theme/wittiness/humor/aesthetic rubric).

// challenge-helpers.ts also imports dbRead/dbWrite/redis for its other (DB-backed) exports —
// stub those so importing the module for this pure-function test doesn't construct real
// Prisma/Redis clients.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/redis/client', () => ({ redis: {}, REDIS_KEYS: {} }));

const { resolveChallengeReviewInputs } = await import('./challenge-helpers');
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');
const { DEFAULT_CATEGORY_ROWS, isDefaultJudgingRubric } = await import(
  '~/shared/constants/challenge.constants'
);

// Stored shape: label/criteria were derived server-side at write time and persisted.
const VALID_CATEGORIES = [
  { key: 'theme', weight: 60, label: 'Theme', criteria: 'fits the theme' },
  { key: 'aesthetic', weight: 40, label: 'Aesthetic', criteria: 'looks good' },
];
// Weight out of range + doesn't sum to 100 -> challengeJudgingCategoriesSchema.safeParse fails.
const MALFORMED_CATEGORIES = [{ key: 'theme', weight: 150, label: 'Theme', criteria: 'x' }];

describe('resolveChallengeReviewInputs — categories resolution', () => {
  it('User source: uses stored categories', async () => {
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.User,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories?.map((c) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('System source: uses stored categories (no source gate)', async () => {
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.System,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories?.map((c) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('Mod source: uses stored categories', async () => {
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.Mod,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeDefined();
  });

  it('malformed categories fall back to the fixed rubric (any source)', async () => {
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.User,
      judgingCategories: MALFORMED_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeUndefined();
  });

  it('null categories fall back to the fixed rubric (any source)', async () => {
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.System,
      judgingCategories: null,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeUndefined();
  });

  // Post-backfill every challenge stores a rubric, so the default split must keep resolving to
  // `undefined` — otherwise daily reviews would start emitting label-cased score keys.
  it('the seeded default rubric falls back to the fixed rubric', async () => {
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.System,
      judgingCategories: DEFAULT_CATEGORY_ROWS,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeUndefined();
  });

  it('a custom rubric that merely shares the default keys is still used', async () => {
    const reweighted = DEFAULT_CATEGORY_ROWS.map((row) =>
      row.key === 'theme' ? { ...row, weight: 60 } : row.key === 'aesthetic' ? { ...row, weight: 10 } : row
    );
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.User,
      judgingCategories: reweighted,
      allowedNsfwLevel: 1,
    });
    expect(categories?.map((c) => c.key)).toEqual(['theme', 'wittiness', 'humor', 'aesthetic']);
  });

  it('maps key/label/criteria to the key/name/criteria shape generateReview expects', async () => {
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.User,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories?.[0]).toEqual(
      expect.objectContaining({
        key: 'theme',
        name: expect.any(String),
        criteria: expect.any(String),
      })
    );
  });
});

describe('isDefaultJudgingRubric', () => {
  it('matches the default rows regardless of row order', () => {
    expect(isDefaultJudgingRubric(DEFAULT_CATEGORY_ROWS)).toBe(true);
    expect(isDefaultJudgingRubric([...DEFAULT_CATEGORY_ROWS].reverse())).toBe(true);
  });

  it('rejects a rubric with a different weight, key set, or size', () => {
    expect(
      isDefaultJudgingRubric(
        DEFAULT_CATEGORY_ROWS.map((r) => (r.key === 'humor' ? { ...r, weight: 16 } : r))
      )
    ).toBe(false);
    expect(isDefaultJudgingRubric(DEFAULT_CATEGORY_ROWS.slice(0, 3))).toBe(false);
    expect(
      isDefaultJudgingRubric(
        DEFAULT_CATEGORY_ROWS.map((r) => (r.key === 'humor' ? { ...r, key: 'horror' } : r))
      )
    ).toBe(false);
  });

  it('rejects empty and nullish rubrics', () => {
    expect(isDefaultJudgingRubric([])).toBe(false);
    expect(isDefaultJudgingRubric(null)).toBe(false);
    expect(isDefaultJudgingRubric(undefined)).toBe(false);
  });
});

describe('resolveChallengeReviewInputs — nsfw derivation', () => {
  it('PG-only allowedNsfwLevel resolves nsfw: false', async () => {
    const { nsfw } = await resolveChallengeReviewInputs({
      source: ChallengeSource.System,
      judgingCategories: null,
      allowedNsfwLevel: 1, // NsfwLevel.PG
    });
    expect(nsfw).toBe(false);
  });

  it('an NSFW-allowed level (X) resolves nsfw: true', async () => {
    const { nsfw } = await resolveChallengeReviewInputs({
      source: ChallengeSource.System,
      judgingCategories: null,
      allowedNsfwLevel: 8, // NsfwLevel.X
    });
    expect(nsfw).toBe(true);
  });
});
