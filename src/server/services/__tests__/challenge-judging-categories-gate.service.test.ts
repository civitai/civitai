import { describe, it, expect, vi, beforeEach } from 'vitest';

// Verifies judging-category routing at the two challenge.service.ts call sites
// (endChallengeAndPickWinners, playgroundPickWinners) after the DYNAMIC_JUDGING_CATEGORIES flag
// removal: any challenge that stores judgingCategories is judged by them regardless of source; a
// malformed/null value falls back to the fixed rubric. getJudgedEntries is mocked so we can assert
// directly on the `categories` arg it receives — the sole observable output of the routing here.

const {
  mockDbWrite,
  mockIsFlipt,
  mockGetJudgedEntries,
  mockGenerateWinners,
  mockGetChallengeById,
  mockGetJudgingConfig,
  mockGetChallengeConfig,
  mockRefundUserChallengeFunds,
} = vi.hoisted(() => {
  return {
    mockDbWrite: {
      challenge: {
        update: vi.fn().mockResolvedValue(undefined),
        // Final-prize recompute reads prizePool/prizeDistribution on the User path; null
        // distribution skips the recompute so these tests exercise the judging gate unchanged.
        findUnique: vi.fn().mockResolvedValue({ prizePool: 0, prizeDistribution: null }),
      },
    },
    mockIsFlipt: vi.fn().mockResolvedValue(false),
    mockGetJudgedEntries: vi.fn(),
    mockGenerateWinners: vi.fn(),
    mockGetChallengeById: vi.fn(),
    mockGetJudgingConfig: vi.fn().mockResolvedValue({
      judgeId: 1,
      userId: 999,
      sourceCollectionId: null,
      prompts: {},
      reviewTemplate: null,
    }),
    mockGetChallengeConfig: vi.fn().mockResolvedValue({
      defaultJudgeId: 1,
      defaultJudge: null,
      judgedTagId: 1,
      reviewMeTagId: 2,
      winnerCooldown: '7 day',
      finalReviewAmount: 10,
      maxScoredPerUser: 5,
      reviewAmount: { min: 6, max: 12 },
    }),
    mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: vi.fn(), challenge: { findUnique: vi.fn() } },
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: mockIsFlipt };
});

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: mockGetChallengeConfig,
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: mockGetJudgingConfig,
}));

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  claimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  closeChallengeCollection: vi.fn().mockResolvedValue(undefined),
  createChallengeWinner: vi.fn().mockResolvedValue(undefined),
  getChallengeById: mockGetChallengeById,
  getChallengeWinners: vi.fn().mockResolvedValue([]),
  getExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  resolveEventContext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateArticle: vi.fn(),
  generateReview: vi.fn(),
  generateThemeElements: vi.fn(),
  generateWinners: mockGenerateWinners,
}));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({
  getCoverOfModel: vi.fn(),
  getJudgedEntries: mockGetJudgedEntries,
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeInitialPrize: vi.fn(),
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
  reportPoolFundingShortfall: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  getTransactionByExternalId: vi.fn(),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(),
}));

vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  imagesForModelVersionsCache: { bust: vi.fn() },
}));

vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(() => ({})),
  getProfilePicturesForUsers: vi.fn(() => ({})),
}));

vi.mock('~/server/services/challenge-eligibility.service', () => ({
  assertCanCreateUserChallenge: vi.fn(),
}));

vi.mock('~/server/integrations/moderation', () => ({
  extModeration: {},
}));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/utils/errorHandling', () => ({
  withRetries: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { endChallengeAndPickWinners, playgroundPickWinners } = await import(
  '~/server/services/challenge.service'
);
const { ChallengeSource, ChallengeStatus } = await import('~/shared/utils/prisma/enums');

// A syntactically valid, weight-summing-to-100, single-theme category set — what
// challengeJudgingCategoriesSchema.safeParse accepts.
const VALID_CATEGORIES = [
  { key: 'theme', weight: 60, label: 'Theme', criteria: 'fits the theme' },
  { key: 'aesthetic', weight: 40, label: 'Aesthetic', criteria: 'looks good' },
];
const MALFORMED_CATEGORIES = [{ key: 'theme', weight: 150, label: 'Theme', criteria: 'x' }]; // weight out of range + doesn't sum to 100

const makeMockChallenge = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Test Challenge',
  status: ChallengeStatus.Active,
  reviewCostType: 'PerEntry',
  reviewCost: 50,
  collectionId: 100,
  startsAt: new Date(),
  endsAt: new Date(Date.now() + 86400000),
  visibleAt: new Date(),
  description: null,
  theme: 'test',
  invitation: null,
  coverImageId: null,
  coverUrl: null,
  coverImageHash: null,
  coverImageWidth: null,
  coverImageHeight: null,
  nsfwLevel: 1,
  allowedNsfwLevel: 1,
  modelVersionIds: [],
  judgeId: null,
  judgingPrompt: null,
  eventId: null,
  reviewPercentage: 100,
  maxReviews: null,
  maxEntriesPerUser: 20,
  prizes: [],
  entryPrize: null,
  entryPrizeRequirement: 10,
  prizePool: 5000,
  operationBudget: 1000,
  operationSpent: 0,
  createdById: 999,
  source: ChallengeSource.System,
  metadata: null,
  judgingCategories: null,
  ...overrides,
});

describe('endChallengeAndPickWinners — judging-category routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeConfig.mockResolvedValue({
      defaultJudgeId: 1,
      defaultJudge: null,
      judgedTagId: 1,
      reviewMeTagId: 2,
      winnerCooldown: '7 day',
      finalReviewAmount: 10,
      maxScoredPerUser: 5,
      reviewAmount: { min: 6, max: 12 },
    });
    mockGetJudgingConfig.mockResolvedValue({
      judgeId: 1,
      userId: 999,
      sourceCollectionId: null,
      prompts: {},
      reviewTemplate: null,
    });
    // Empty judged entries short-circuits right after the gate — the branch we care about —
    // without needing to mock the full winner-generation/prize/notification pipeline.
    mockGetJudgedEntries.mockResolvedValue([]);
    mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 0 });
  });

  it('User source: uses categories', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ source: ChallengeSource.User, judgingCategories: VALID_CATEGORIES })
    );

    await endChallengeAndPickWinners(1);

    expect(mockGetJudgedEntries).toHaveBeenCalledTimes(1);
    const categoriesArg = mockGetJudgedEntries.mock.calls[0][4];
    expect(categoriesArg).toBeDefined();
    expect(categoriesArg.map((c: { key: string }) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('System source + categories: uses categories (no source gate)', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ source: ChallengeSource.System, judgingCategories: VALID_CATEGORIES })
    );

    await endChallengeAndPickWinners(1);

    const categoriesArg = mockGetJudgedEntries.mock.calls[0][4];
    expect(categoriesArg).toBeDefined();
    expect(categoriesArg.map((c: { key: string }) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('Mod source + categories: uses categories', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ source: ChallengeSource.Mod, judgingCategories: VALID_CATEGORIES })
    );

    await endChallengeAndPickWinners(1);

    expect(mockGetJudgedEntries.mock.calls[0][4]).toBeDefined();
  });

  it('malformed categories fall back to the fixed rubric (User source)', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ source: ChallengeSource.User, judgingCategories: MALFORMED_CATEGORIES })
    );

    await endChallengeAndPickWinners(1);

    expect(mockGetJudgedEntries.mock.calls[0][4]).toBeUndefined();
  });

  it('null categories fall back to the fixed rubric (System source)', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ source: ChallengeSource.System, judgingCategories: null })
    );

    await endChallengeAndPickWinners(1);

    expect(mockGetJudgedEntries.mock.calls[0][4]).toBeUndefined();
  });
});

describe('playgroundPickWinners — judging-category routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeConfig.mockResolvedValue({
      defaultJudgeId: 1,
      defaultJudge: null,
      judgedTagId: 1,
      reviewMeTagId: 2,
      winnerCooldown: '7 day',
      finalReviewAmount: 10,
      maxScoredPerUser: 5,
      reviewAmount: { min: 6, max: 12 },
    });
    mockGetJudgingConfig.mockResolvedValue({
      judgeId: 1,
      userId: 999,
      sourceCollectionId: null,
      prompts: {},
      reviewTemplate: null,
    });
    // 3 entries clears playgroundPickWinners' `entries.length < 3` guard so we reach
    // generateWinners — the call args to getJudgedEntries are what we assert on.
    mockGetJudgedEntries.mockResolvedValue([
      { imageId: 1, userId: 1, username: 'a', summary: 's', score: {} },
      { imageId: 2, userId: 2, username: 'b', summary: 's', score: {} },
      { imageId: 3, userId: 3, username: 'c', summary: 's', score: {} },
    ]);
    mockGenerateWinners.mockResolvedValue({ winners: [], process: '', outcome: '' });
  });

  it('User source: uses categories', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({
        id: 5,
        collectionId: 100,
        source: ChallengeSource.User,
        judgingCategories: VALID_CATEGORIES,
      })
    );

    await playgroundPickWinners({ challengeId: 5 } as never);

    const categoriesArg = mockGetJudgedEntries.mock.calls[0][4];
    expect(categoriesArg).toBeDefined();
    expect(categoriesArg.map((c: { key: string }) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('System source + categories: uses categories (no source gate)', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({
        id: 5,
        collectionId: 100,
        source: ChallengeSource.System,
        judgingCategories: VALID_CATEGORIES,
      })
    );

    await playgroundPickWinners({ challengeId: 5 } as never);

    const categoriesArg = mockGetJudgedEntries.mock.calls[0][4];
    expect(categoriesArg).toBeDefined();
    expect(categoriesArg.map((c: { key: string }) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('Mod source + categories: uses categories', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({
        id: 5,
        collectionId: 100,
        source: ChallengeSource.Mod,
        judgingCategories: VALID_CATEGORIES,
      })
    );

    await playgroundPickWinners({ challengeId: 5 } as never);

    expect(mockGetJudgedEntries.mock.calls[0][4]).toBeDefined();
  });

  it('malformed categories fall back to the fixed rubric (User source)', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({
        id: 5,
        collectionId: 100,
        source: ChallengeSource.User,
        judgingCategories: MALFORMED_CATEGORIES,
      })
    );

    await playgroundPickWinners({ challengeId: 5 } as never);

    expect(mockGetJudgedEntries.mock.calls[0][4]).toBeUndefined();
  });
});
