import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 8 fix round 1: proves endChallengeAndPickWinners assembles excludeUserIds as the union of
// winners AND participation-prize earners, not winners alone. sendChallengeResultsNotification
// itself is mocked at the module boundary so this test only has to assert on the ids the call site
// hands it, without re-exercising getChallengeReminderRecipients' own DB queries (covered by
// challenge-results-notification.test.ts).

const {
  mockDbWrite,
  mockDbReadQueryRaw,
  mockGetChallengeById,
  mockGetExistingWinnersForRetry,
  mockSendChallengeResultsNotification,
} = vi.hoisted(() => ({
  mockDbWrite: {
    challenge: {
      update: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue({ prizePool: 0, prizeDistribution: null }),
    },
  },
  mockDbReadQueryRaw: vi.fn(),
  mockGetChallengeById: vi.fn(),
  mockGetExistingWinnersForRetry: vi.fn(),
  mockSendChallengeResultsNotification: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: mockDbReadQueryRaw, challenge: { findUnique: vi.fn() } },
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: vi.fn().mockResolvedValue({
    defaultJudgeId: 1,
    defaultJudge: null,
    judgedTagId: 1,
    reviewMeTagId: 2,
    winnerCooldown: '7 day',
    finalReviewAmount: 10,
    maxScoredPerUser: 5,
    reviewAmount: { min: 6, max: 12 },
  }),
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: vi.fn().mockResolvedValue({
    judgeId: 1,
    userId: 999,
    sourceCollectionId: null,
    prompts: {},
    reviewTemplate: null,
  }),
}));

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  claimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  closeChallengeCollection: vi.fn().mockResolvedValue(undefined),
  createChallengeWinner: vi.fn().mockResolvedValue(undefined),
  getChallengeById: mockGetChallengeById,
  getChallengeWinners: vi.fn().mockResolvedValue([]),
  getExistingWinnersForRetry: mockGetExistingWinnersForRetry,
  resolveEventContext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  buildWinnerPayoutTransactions: vi.fn().mockReturnValue([]),
  chargeInitialPrize: vi.fn(),
  refundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  reportPoolFundingShortfall: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateArticle: vi.fn(),
  generateReview: vi.fn(),
  generateThemeElements: vi.fn(),
  generateWinners: vi.fn(),
}));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({
  getCoverOfModel: vi.fn(),
  getJudgedEntries: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  getTransactionByExternalId: vi.fn(),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/challenge-engagement.service', () => ({
  sendChallengeResultsNotification: mockSendChallengeResultsNotification,
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

const { endChallengeAndPickWinners } = await import('~/server/services/challenge.service');
const { ChallengeSource, ChallengeStatus } = await import('~/shared/utils/prisma/enums');

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
  prizes: [{ buzz: 100, points: 0 }],
  entryPrize: { buzz: 50, points: 0 },
  entryPrizeRequirement: 1,
  prizePool: 5000,
  operationBudget: 1000,
  operationSpent: 0,
  createdById: 999,
  source: ChallengeSource.System,
  buzzType: 'green',
  metadata: null,
  judgingCategories: null,
  ...overrides,
});

describe('endChallengeAndPickWinners — sendChallengeResultsNotification excludeUserIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeById.mockResolvedValue(makeMockChallenge());
    // Existing-winners retry path: skips the LLM judging maze entirely, going straight to payout.
    mockGetExistingWinnersForRetry.mockResolvedValue([
      { userId: 1, imageId: 10, place: 1, buzzAwarded: 100, reason: null },
    ]);
    mockDbWrite.challenge.update.mockResolvedValue(undefined);
  });

  it('excludes both the winner and the participation-prize earners', async () => {
    // Entry-prize eligible pool: user 1 (the winner, must be filtered out by the source itself),
    // plus users 2 and 3 (participation-prize earners who are not winners).
    mockDbReadQueryRaw.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }, { userId: 3 }]);

    await endChallengeAndPickWinners(1);

    expect(mockSendChallengeResultsNotification).toHaveBeenCalledTimes(1);
    const arg = mockSendChallengeResultsNotification.mock.calls[0][0] as {
      excludeUserIds: number[];
    };
    expect([...arg.excludeUserIds].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('excludes only the winner when nobody separately earned the participation prize', async () => {
    mockDbReadQueryRaw.mockResolvedValueOnce([{ userId: 1 }]);

    await endChallengeAndPickWinners(1);

    const arg = mockSendChallengeResultsNotification.mock.calls[0][0] as {
      excludeUserIds: number[];
    };
    expect([...arg.excludeUserIds].sort((a, b) => a - b)).toEqual([1]);
  });
});
