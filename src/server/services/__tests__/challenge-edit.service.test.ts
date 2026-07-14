import { TRPCError } from '@trpc/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define mocks available in vi.mock factories
const {
  mockDbRead,
  mockGetChallengeConfig,
  mockGetChallengeById,
  mockAssertUserInGoodStanding,
  mockAssertCanCreateUserChallenge,
  mockResolveJudgingCategories,
} = vi.hoisted(() => {
  return {
    mockDbRead: {
      $queryRaw: vi.fn(),
      modelVersion: { findMany: vi.fn() },
      image: { findUnique: vi.fn(), findFirst: vi.fn() },
      challenge: { findUnique: vi.fn() },
      challengeJudge: { findFirst: vi.fn() },
    },
    mockGetChallengeConfig: vi.fn(),
    mockGetChallengeById: vi.fn(),
    mockAssertUserInGoodStanding: vi.fn(),
    mockAssertCanCreateUserChallenge: vi.fn(),
    mockResolveJudgingCategories: vi.fn(),
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

vi.mock('~/server/services/challenge-eligibility.service', () => ({
  assertCanCreateUserChallenge: mockAssertCanCreateUserChallenge,
  assertUserInGoodStanding: mockAssertUserInGoodStanding,
}));

vi.mock('~/server/services/challenge-category.service', () => ({
  resolveJudgingCategories: mockResolveJudgingCategories,
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
const { getChallengeForEdit, upsertUserChallenge } = await import(
  '~/server/services/challenge.service'
);

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

    // Stored label/criteria were server-derived at write time and are trusted on read (they are
    // re-derived from the ChallengeCategory library on the next save).
    expect(result?.judgingCategories).toEqual(storedCategories);
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

describe('upsertUserChallenge (edit branch) — creator standing re-check', () => {
  // Enough to clear the pre-standing-check steps (judge lookup, category resolution) and reach
  // the cover-image/existing-challenge lookups. userId must match assertions below.
  const editInput = {
    id: 42,
    userId: 111,
    buzzType: 'yellow' as const,
    title: 'Edited title',
    description: 'desc',
    theme: 'Neon',
    coverImage: { id: 555, url: 'unused' },
    allowedNsfwLevel: 1,
    modelVersionIds: [],
    judgeId: 1,
    judgingCategories: [],
    entryFee: 50,
    initialPrizeBuzz: 0,
    prizeDistribution: [],
    maxEntriesPerUser: 5,
    startsAt: new Date(Date.now() + 86400000),
    endsAt: new Date(Date.now() + 2 * 86400000),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.challengeJudge.findFirst.mockResolvedValue({ id: 1 });
    mockDbRead.image.findFirst.mockResolvedValue({ id: 555 });
    mockResolveJudgingCategories.mockResolvedValue([]);
  });

  it('throws when the creator has fallen out of good standing (muted/struck/banned)', async () => {
    mockAssertUserInGoodStanding.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Muted accounts cannot create challenges.' })
    );

    await expect(upsertUserChallenge(editInput as never)).rejects.toThrow(
      'Muted accounts cannot create challenges.'
    );

    expect(mockAssertUserInGoodStanding).toHaveBeenCalledWith(111);
    // Score/cap/daily-limit gates are create-only concerns — must not run on edit.
    expect(mockAssertCanCreateUserChallenge).not.toHaveBeenCalled();
    // Standing gate sits before the existing-challenge/cover-image lookups, so a since-muted
    // creator can't trigger those side effects.
    expect(mockDbRead.challenge.findUnique).not.toHaveBeenCalled();
    expect(mockDbRead.image.findFirst).not.toHaveBeenCalled();
  });

  it('does not throw on the standing check when the creator is in good standing', async () => {
    mockAssertUserInGoodStanding.mockResolvedValueOnce({
      scoreTotal: 0,
      bannedAt: null,
      muted: false,
      deletedAt: null,
      activeStrikes: 0,
    });
    // Downstream (unrelated to standing): simulate the challenge no longer existing, so a
    // rejection here can only come from the next real gate, not the standing check.
    mockDbRead.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(upsertUserChallenge(editInput as never)).rejects.toThrow('Challenge not found');

    expect(mockAssertUserInGoodStanding).toHaveBeenCalledWith(111);
    expect(mockAssertCanCreateUserChallenge).not.toHaveBeenCalled();
  });
});
