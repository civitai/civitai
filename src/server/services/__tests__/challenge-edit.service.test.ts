import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define mocks available in vi.mock factories
const { mockDbRead, mockGetChallengeConfig, mockGetChallengeById } = vi.hoisted(() => {
  return {
    mockDbRead: {
      $queryRaw: vi.fn(),
      modelVersion: { findMany: vi.fn() },
      image: { findUnique: vi.fn() },
    },
    mockGetChallengeConfig: vi.fn(),
    mockGetChallengeById: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: mockGetChallengeConfig,
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  getChallengeById: mockGetChallengeById,
  getChallengeWinners: vi.fn(() => []),
  closeChallengeCollection: vi.fn(),
  createChallengeWinner: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateWinners: vi.fn(),
}));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({
  getJudgedEntries: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  imagesForModelVersionsCache: { bust: vi.fn(), fetch: vi.fn(() => ({})) },
}));

vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(() => ({})),
  getProfilePicturesForUsers: vi.fn(() => ({})),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(),
}));

vi.mock('~/utils/errorHandling', () => ({
  withRetries: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

vi.mock('~/server/utils/errorHandling', () => ({
  throwNotFoundError: vi.fn((msg: string) => {
    throw new Error(msg);
  }),
}));

// Import after mocks are set up (top-level, not in beforeEach)
const { getChallengeForEdit } = await import('~/server/services/challenge.service');

const mockConfig = {
  reviewMeTagId: 301770,
  judgedTagId: 299729,
  maxScoredPerUser: 5,
  reviewAmount: { min: 6, max: 12 },
};

const makeMockChallenge = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Test Challenge',
  status: 'Active' as const,
  reviewCostType: 'PerEntry' as const,
  reviewCost: 50,
  collectionId: null,
  startsAt: new Date(),
  endsAt: new Date(Date.now() + 86400000),
  visibleAt: new Date(),
  description: null,
  theme: 'test',
  invitation: null,
  coverImageId: null,
  nsfwLevel: 1,
  allowedNsfwLevel: 1,
  modelVersionIds: [],
  judgeId: null,
  judgingPrompt: null,
  reviewPercentage: 100,
  maxReviews: null,
  maxEntriesPerUser: 20,
  prizes: [],
  entryPrize: null,
  entryPrizeRequirement: 10,
  prizePool: 5000,
  basePrizePool: 0,
  buzzPerAction: 0,
  poolTrigger: null,
  maxPrizePool: null,
  prizeMode: 'Fixed' as const,
  prizeDistribution: null,
  operationBudget: 1000,
  operationSpent: 0,
  createdById: 999,
  source: 'System' as const,
  eventId: null,
  metadata: null,
  judgingCategories: null as unknown,
  ...overrides,
});

describe('getChallengeForEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeConfig.mockResolvedValue(mockConfig);
    // Creator lookup query used by buildChallengeDetail
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: 999, username: 'creator', image: null, deletedAt: null },
    ]);
  });

  it('returns parsed judgingCategories when the challenge has valid stored categories', async () => {
    const storedCategories = [
      { key: 'theme', weight: 60, label: 'Theme', criteria: 'stale criteria text' },
      { key: 'creativity', weight: 40, label: 'Creativity', criteria: 'stale criteria text' },
    ];
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ judgingCategories: storedCategories })
    );

    const result = await getChallengeForEdit(1);

    expect(result?.judgingCategories).toEqual([
      {
        key: 'theme',
        weight: 60,
        label: 'Theme',
        criteria:
          'How well the entry fits and interprets the challenge theme; higher for a clear, strong, on-theme interpretation.',
      },
      {
        key: 'creativity',
        weight: 40,
        label: 'Creativity',
        criteria:
          'Originality and inventiveness of the concept; higher for fresh, unexpected takes over clichés.',
      },
    ]);
  });

  it('returns null when the challenge has no stored categories', async () => {
    mockGetChallengeById.mockResolvedValue(makeMockChallenge({ judgingCategories: null }));

    const result = await getChallengeForEdit(1);

    expect(result?.judgingCategories).toBeNull();
  });

  it('returns null when the stored categories are malformed', async () => {
    // Weights don't sum to 100 -> fails challengeJudgingCategoriesSchema's superRefine
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({
        judgingCategories: [{ key: 'theme', weight: 60 }],
      })
    );

    const result = await getChallengeForEdit(1);

    expect(result?.judgingCategories).toBeNull();
  });
});
