import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Use vi.hoisted to define mocks available in vi.mock factories
const {
  mockDbRead,
  mockDbWrite,
  mockCreateBuzzTransaction,
  mockCreateBuzzTransactionMany,
  mockGetChallengeConfig,
  mockGetChallengeById,
} = vi.hoisted(() => {
  return {
    mockDbRead: {
      challenge: { findUnique: vi.fn() },
      $queryRaw: vi.fn(),
    },
    mockDbWrite: {
      $executeRaw: vi.fn(),
    },
    mockCreateBuzzTransaction: vi.fn(),
    mockCreateBuzzTransactionMany: vi.fn(),
    mockGetChallengeConfig: vi.fn(),
    mockGetChallengeById: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mockCreateBuzzTransaction,
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
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
  imagesForModelVersionsCache: { bust: vi.fn() },
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
const { requestReview, getUserUnjudgedEntries } = await import(
  '~/server/services/challenge.service'
);

const mockConfig = {
  reviewMeTagId: 301770,
  judgedTagId: 299729,
  maxScoredPerUser: 5,
  reviewAmount: { min: 6, max: 12 },
};

const makeMockChallenge = (overrides = {}) => ({
  id: 1,
  title: 'Test Challenge',
  status: 'Active' as const,
  reviewCostType: 'PerEntry' as const,
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
  source: 'System' as const,
  metadata: null,
  ...overrides,
});

describe('requestReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeConfig.mockResolvedValue(mockConfig);
  });

  it('should charge buzz and tag entries with reviewMeTagId', async () => {
    mockGetChallengeById.mockResolvedValue(makeMockChallenge());
    mockDbRead.$queryRaw.mockResolvedValue([{ imageId: 10 }, { imageId: 11 }]);
    mockCreateBuzzTransactionMany.mockResolvedValue(undefined);
    mockDbWrite.$executeRaw.mockResolvedValue(2);

    const result = await requestReview(1, [10, 11], 42);

    expect(result).toEqual({ queued: 2, totalCost: 100 });
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          fromAccountId: 42,
          toAccountId: 0,
          amount: 50,
        }),
      ])
    );
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith(expect.any(Array));
    expect(mockDbWrite.$executeRaw).toHaveBeenCalled();
  });

  it('should throw if challenge not found', async () => {
    mockGetChallengeById.mockResolvedValue(null);

    await expect(requestReview(999, [1], 42)).rejects.toThrow(TRPCError);
  });

  it('should throw if challenge is not active', async () => {
    mockGetChallengeById.mockResolvedValue(makeMockChallenge({ status: 'Completed' }));

    await expect(requestReview(1, [1], 42)).rejects.toThrow('not active');
  });

  it('should throw if reviewCostType is None', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ reviewCostType: 'None', reviewCost: 0 })
    );

    await expect(requestReview(1, [1], 42)).rejects.toThrow('not available');
  });

  it('should throw if challenge has no collection', async () => {
    mockGetChallengeById.mockResolvedValue(makeMockChallenge({ collectionId: null }));

    await expect(requestReview(1, [1], 42)).rejects.toThrow('no collection');
  });

  it('should throw if some entries are not eligible', async () => {
    mockGetChallengeById.mockResolvedValue(makeMockChallenge());
    // Only 1 of 2 entries is eligible
    mockDbRead.$queryRaw.mockResolvedValue([{ imageId: 10 }]);

    await expect(requestReview(1, [10, 11], 42)).rejects.toThrow('not eligible');
  });

  it('should calculate cost as reviewCost * entry count', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ reviewCostType: 'PerEntry', reviewCost: 25 })
    );
    mockDbRead.$queryRaw.mockResolvedValue([{ imageId: 1 }, { imageId: 2 }, { imageId: 3 }]);
    mockCreateBuzzTransactionMany.mockResolvedValue(undefined);
    mockDbWrite.$executeRaw.mockResolvedValue(3);

    const result = await requestReview(1, [1, 2, 3], 42);

    expect(result.totalCost).toBe(75); // 25 * 3
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ fromAccountId: 42, amount: 25 })])
    );
    expect(mockCreateBuzzTransactionMany.mock.calls[0][0]).toHaveLength(3);
  });
});

describe('getUserUnjudgedEntries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeConfig.mockResolvedValue(mockConfig);
  });

  it('should return empty entries if reviewCostType is None', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue({
      collectionId: 100,
      reviewCostType: 'None',
      reviewCost: 0,
    });

    const result = await getUserUnjudgedEntries(1, 42);
    expect(result).toEqual({ entries: [], hasFlatRatePurchase: false });
  });

  it('should return empty entries if no collection', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue({
      collectionId: null,
      reviewCostType: 'PerEntry',
      reviewCost: 50,
    });

    const result = await getUserUnjudgedEntries(1, 42);
    expect(result).toEqual({ entries: [], hasFlatRatePurchase: false });
  });

  it('should return unjudged entries', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue({
      collectionId: 100,
      reviewCostType: 'PerEntry',
      reviewCost: 50,
    });
    mockDbRead.$queryRaw.mockResolvedValue([
      { imageId: 10, url: 'img10.jpg' },
      { imageId: 11, url: 'img11.jpg' },
    ]);

    const result = await getUserUnjudgedEntries(1, 42);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ imageId: 10, url: 'img10.jpg' });
    expect(result.hasFlatRatePurchase).toBe(false);
  });

  it('should return empty entries if challenge not found', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(null);

    const result = await getUserUnjudgedEntries(999, 42);
    expect(result).toEqual({ entries: [], hasFlatRatePurchase: false });
  });
});
