import { describe, it, expect, vi, beforeEach } from 'vitest';

// Verifies `resolveChallengeReviewInputs` — the category+nsfw resolution extracted out of
// reviewEntriesForChallenge (~/server/jobs/daily-challenge-processing.ts) so the mod re-review
// endpoint (~/pages/api/mod/daily-challenge/re-review.ts) can mirror it exactly instead of
// re-reviewing non-user challenges with the fixed rubric regardless of their configured
// judgingCategories. Gate: `source === ChallengeSource.User || isFlipt(DYNAMIC_JUDGING_CATEGORIES)`.
// A malformed/null judgingCategories value always falls back to `categories: undefined` (fixed
// rubric), even when the gate is open.

const { mockIsFlipt } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn().mockResolvedValue(false),
}));

// challenge-helpers.ts also imports dbRead/dbWrite/redis for its other (DB-backed) exports —
// stub those so importing the module for this pure-function test doesn't construct real
// Prisma/Redis clients.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/redis/client', () => ({ redis: {}, REDIS_KEYS: {} }));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: mockIsFlipt };
});

const { resolveChallengeReviewInputs } = await import('./challenge-helpers');
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');

// Stored shape: label/criteria were derived server-side at write time and persisted.
const VALID_CATEGORIES = [
  { key: 'theme', weight: 60, label: 'Theme', criteria: 'fits the theme' },
  { key: 'aesthetic', weight: 40, label: 'Aesthetic', criteria: 'looks good' },
];
// Weight out of range + doesn't sum to 100 -> challengeJudgingCategoriesSchema.safeParse fails.
const MALFORMED_CATEGORIES = [{ key: 'theme', weight: 150, label: 'Theme', criteria: 'x' }];

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFlipt.mockResolvedValue(false);
});

describe('resolveChallengeReviewInputs — categories gate', () => {
  it('User source: uses categories regardless of flag (flag off)', async () => {
    mockIsFlipt.mockResolvedValue(false);
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.User,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeDefined();
    expect(categories?.map((c) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('System source, flag off: falls back to fixed rubric (no categories)', async () => {
    mockIsFlipt.mockResolvedValue(false);
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.System,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeUndefined();
  });

  it('System source, flag on: uses categories', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.System,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeDefined();
    expect(categories?.map((c) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('Mod source, flag on: uses categories (non-User sources generalize identically)', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.Mod,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeDefined();
  });

  it('malformed categories always fall back, even flag on + User source', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.User,
      judgingCategories: MALFORMED_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeUndefined();
  });

  it('null categories always fall back regardless of flag/source', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.System,
      judgingCategories: null,
      allowedNsfwLevel: 1,
    });
    expect(categories).toBeUndefined();
  });

  it('maps key/label/criteria to the key/name/criteria shape generateReview expects', async () => {
    mockIsFlipt.mockResolvedValue(false);
    const { categories } = await resolveChallengeReviewInputs({
      source: ChallengeSource.User,
      judgingCategories: VALID_CATEGORIES,
      allowedNsfwLevel: 1,
    });
    expect(categories?.[0]).toEqual(
      expect.objectContaining({ key: 'theme', name: expect.any(String), criteria: expect.any(String) })
    );
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
