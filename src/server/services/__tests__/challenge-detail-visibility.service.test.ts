import { describe, it, expect, vi, beforeEach } from 'vitest';

// getChallengeDetail visibility: moderators and the challenge owner must be able to open the
// detail page of a user challenge regardless of its scan/POI/cover state (a stuck-Scheduled
// challenge 404'd for mods because the scan gate only exempted the creator). The public gates
// must keep applying to everyone else.
const { mockDbRead, mockGetChallengeById } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(),
    modelVersion: { findMany: vi.fn() },
    image: { findUnique: vi.fn(), findFirst: vi.fn() },
    challenge: { findUnique: vi.fn() },
    collectionItem: { count: vi.fn() },
  },
  mockGetChallengeById: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: vi.fn(() => ({
    reviewMeTagId: 301770,
    judgedTagId: 299729,
    maxScoredPerUser: 5,
    reviewAmount: { min: 6, max: 12 },
  })),
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
  assertCanCreateUserChallenge: vi.fn(),
  assertUserInGoodStanding: vi.fn(),
  assertUserAccountInGoodStanding: vi.fn(),
}));

vi.mock('~/server/services/challenge-category.service', () => ({
  resolveJudgingCategories: vi.fn(() => []),
}));

vi.mock('~/server/services/challenge-judge.service', () => ({
  getUserSelectableJudges: vi.fn(() => []),
}));

vi.mock('~/server/services/text-moderation.service', () => ({
  submitTextModeration: vi.fn(),
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(),
}));

vi.mock('~/utils/errorHandling', () => ({
  withRetries: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { getChallengeDetail } = await import('~/server/services/challenge.service');

const OWNER_ID = 111;
const MOD_ID = 222;
const RANDO_ID = 333;

const makeUserChallenge = (overrides: Record<string, unknown> = {}) => ({
  id: 400,
  title: 'Stuck Challenge',
  status: 'Scheduled' as const,
  reviewCostType: 'PerEntry' as const,
  reviewCost: 50,
  collectionId: null,
  startsAt: new Date('2030-01-10T18:00:00Z'),
  endsAt: new Date('2030-01-12T18:00:00Z'),
  visibleAt: new Date('2020-01-01T00:00:00Z'),
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
  createdById: OWNER_ID,
  source: 'User' as const,
  eventId: null,
  metadata: null,
  judgingCategories: null as unknown,
  buzzType: 'yellow',
  ingestion: 'Pending' as const,
  ...overrides,
});

describe('getChallengeDetail — mod/owner preview of hidden user challenges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Creator lookup inside buildChallengeDetail
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: OWNER_ID, username: 'creator', image: null, deletedAt: null },
    ]);
  });

  describe('scan gate (ingestion != Scanned)', () => {
    it('returns the detail for a moderator', async () => {
      mockGetChallengeById.mockResolvedValue(makeUserChallenge());
      const result = await getChallengeDetail(400, MOD_ID, false, true);
      expect(result).not.toBeNull();
    });

    it('returns the detail for the owner', async () => {
      mockGetChallengeById.mockResolvedValue(makeUserChallenge());
      const result = await getChallengeDetail(400, OWNER_ID, false, false);
      expect(result).not.toBeNull();
    });

    it('stays hidden from other users and anonymous', async () => {
      mockGetChallengeById.mockResolvedValue(makeUserChallenge());
      expect(await getChallengeDetail(400, RANDO_ID, false, false)).toBeNull();
      expect(await getChallengeDetail(400, undefined, false, undefined)).toBeNull();
    });
  });

  describe('POI / cover-scan gates', () => {
    it('returns the detail for a moderator when the cover is POI-flagged', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', coverImageId: 77 })
      );
      mockDbRead.image.findUnique.mockResolvedValue({ poi: true, ingestion: 'Scanned' });

      const result = await getChallengeDetail(400, MOD_ID, false, true);
      expect(result).not.toBeNull();
    });

    it('returns the detail for a moderator when the cover scan is still pending', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', coverImageId: 77 })
      );
      mockDbRead.image.findUnique.mockResolvedValue({ poi: false, ingestion: 'Pending' });

      const result = await getChallengeDetail(400, MOD_ID, false, true);
      expect(result).not.toBeNull();
    });

    it('keeps hiding a POI cover from other users', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', coverImageId: 77 })
      );
      mockDbRead.image.findUnique.mockResolvedValue({ poi: true, ingestion: 'Scanned' });

      expect(await getChallengeDetail(400, RANDO_ID, false, false)).toBeNull();
    });
  });
});
