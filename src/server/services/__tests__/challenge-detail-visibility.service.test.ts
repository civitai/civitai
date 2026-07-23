import { describe, it, expect, vi, beforeEach } from 'vitest';

// getChallengeDetail visibility: moderators and the challenge owner must be able to open the
// detail page of a user challenge regardless of its scan/POI/cover state (a stuck-Scheduled
// challenge 404'd for mods because the scan gate only exempted the creator). The public gates
// must keep applying to everyone else.
const { mockDbRead, mockGetChallengeById, mockAmIBlockedByUser } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(),
    modelVersion: { findMany: vi.fn() },
    image: { findUnique: vi.fn(), findFirst: vi.fn() },
    challenge: { findUnique: vi.fn() },
    collectionItem: { count: vi.fn() },
  },
  mockGetChallengeById: vi.fn(),
  mockAmIBlockedByUser: vi.fn(),
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
  amIBlockedByUser: mockAmIBlockedByUser,
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

// Every case below is a User-source challenge, so each call passes canAccessUserChallenges: true —
// otherwise the flag gate would short-circuit before the gate under test ever ran. The flag gate
// itself is covered in its own describe at the bottom of this file.
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
      const result = await getChallengeDetail(400, MOD_ID, false, true, true);
      expect(result).not.toBeNull();
    });

    it('returns the detail for the owner', async () => {
      mockGetChallengeById.mockResolvedValue(makeUserChallenge());
      const result = await getChallengeDetail(400, OWNER_ID, false, false, true);
      expect(result).not.toBeNull();
    });

    it('stays hidden from other users and anonymous', async () => {
      mockGetChallengeById.mockResolvedValue(makeUserChallenge());
      expect(await getChallengeDetail(400, RANDO_ID, false, false, true)).toBeNull();
      expect(await getChallengeDetail(400, undefined, false, undefined, true)).toBeNull();
    });
  });

  describe('POI / cover-scan gates', () => {
    it('returns the detail for a moderator when the cover is POI-flagged', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', coverImageId: 77 })
      );
      mockDbRead.image.findUnique.mockResolvedValue({ poi: true, ingestion: 'Scanned' });

      const result = await getChallengeDetail(400, MOD_ID, false, true, true);
      expect(result).not.toBeNull();
    });

    it('returns the detail for a moderator when the cover scan is still pending', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', coverImageId: 77 })
      );
      mockDbRead.image.findUnique.mockResolvedValue({ poi: false, ingestion: 'Pending' });

      const result = await getChallengeDetail(400, MOD_ID, false, true, true);
      expect(result).not.toBeNull();
    });

    it('keeps hiding a POI cover from other users', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', coverImageId: 77 })
      );
      mockDbRead.image.findUnique.mockResolvedValue({ poi: true, ingestion: 'Scanned' });

      expect(await getChallengeDetail(400, RANDO_ID, false, false, true)).toBeNull();
    });
  });

  describe('domain-currency gate', () => {
    it('returns the detail for a moderator despite domain mismatch', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', buzzType: 'yellow' })
      );

      // green site viewer + yellow challenge would normally be hidden by domain-currency gate
      const result = await getChallengeDetail(400, MOD_ID, true, true, true);
      expect(result).not.toBeNull();
    });

    it('returns the detail for the owner despite domain mismatch', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', buzzType: 'yellow' })
      );

      const result = await getChallengeDetail(400, OWNER_ID, true, false, true);
      expect(result).not.toBeNull();
    });

    it('returns a yellow challenge on the green site so the client can render the redirect gate', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', buzzType: 'yellow' })
      );

      expect(await getChallengeDetail(400, RANDO_ID, true, false, true)).not.toBeNull();
      expect(await getChallengeDetail(400, undefined, true, false, true)).not.toBeNull();
    });

    it('keeps green challenges hidden from other users on the red site', async () => {
      mockGetChallengeById.mockResolvedValue(
        makeUserChallenge({ ingestion: 'Scanned', buzzType: 'green' })
      );

      expect(await getChallengeDetail(400, RANDO_ID, false, false, true)).toBeNull();
      expect(await getChallengeDetail(400, undefined, false, false, true)).toBeNull();
    });
  });
});

// User-created challenges are still behind the `userChallenges` flag. Gating in the service (not
// just the feed UI) is what closes the direct-link hole: the detail page's SSG prefetch and every
// client fetch resolve through here, so a viewer without the flag gets nothing to render.
describe('getChallengeDetail — userChallenges flag gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: OWNER_ID, username: 'creator', image: null, deletedAt: null },
    ]);
  });

  it('hides a fully visible user challenge from a viewer without the flag', async () => {
    mockGetChallengeById.mockResolvedValue(makeUserChallenge({ ingestion: 'Scanned' }));

    expect(await getChallengeDetail(400, RANDO_ID, false, false, false)).toBeNull();
  });

  it('hides it even from the owner and a moderator without the flag', async () => {
    mockGetChallengeById.mockResolvedValue(makeUserChallenge({ ingestion: 'Scanned' }));

    expect(await getChallengeDetail(400, OWNER_ID, false, false, false)).toBeNull();
    expect(await getChallengeDetail(400, MOD_ID, false, true, false)).toBeNull();
  });

  it('fails closed when the caller omits the flag entirely', async () => {
    mockGetChallengeById.mockResolvedValue(makeUserChallenge({ ingestion: 'Scanned' }));

    expect(await getChallengeDetail(400, RANDO_ID, false, false)).toBeNull();
  });

  it('leaves System (daily) challenges reachable without the flag', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeUserChallenge({ ingestion: 'Scanned', source: 'System', buzzType: 'yellow' })
    );

    expect(await getChallengeDetail(400, RANDO_ID, false, false, false)).not.toBeNull();
  });
});

describe('getChallengeDetail — creator block gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: OWNER_ID, username: 'creator', image: null, deletedAt: null },
    ]);
  });

  it('hides a user challenge from a viewer the creator has blocked', async () => {
    mockGetChallengeById.mockResolvedValue(makeUserChallenge({ ingestion: 'Scanned' }));
    mockAmIBlockedByUser.mockResolvedValue(true);
    expect(await getChallengeDetail(400, RANDO_ID, false, false, true)).toBeNull();
    expect(mockAmIBlockedByUser).toHaveBeenCalledWith({ userId: RANDO_ID, targetUserId: OWNER_ID });
  });

  it('still shows it to a viewer who is not blocked', async () => {
    mockGetChallengeById.mockResolvedValue(makeUserChallenge({ ingestion: 'Scanned' }));
    mockAmIBlockedByUser.mockResolvedValue(false);
    expect(await getChallengeDetail(400, RANDO_ID, false, false, true)).not.toBeNull();
  });

  it('exempts moderators even when blocked', async () => {
    mockGetChallengeById.mockResolvedValue(makeUserChallenge({ ingestion: 'Scanned' }));
    mockAmIBlockedByUser.mockResolvedValue(true);
    expect(await getChallengeDetail(400, MOD_ID, false, true, true)).not.toBeNull();
    expect(mockAmIBlockedByUser).not.toHaveBeenCalled();
  });

  it('does not block-gate System (daily) challenges', async () => {
    mockGetChallengeById.mockResolvedValue(
      makeUserChallenge({ ingestion: 'Scanned', source: 'System', buzzType: 'yellow' })
    );
    mockAmIBlockedByUser.mockResolvedValue(true);
    expect(await getChallengeDetail(400, RANDO_ID, false, false, true)).not.toBeNull();
    expect(mockAmIBlockedByUser).not.toHaveBeenCalled();
  });
});
