import { TRPCError } from '@trpc/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define mocks available in vi.mock factories
const {
  mockDbRead,
  mockGetChallengeConfig,
  mockGetChallengeById,
  mockAssertUserAccountInGoodStanding,
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
    },
    mockGetChallengeConfig: vi.fn(),
    mockGetChallengeById: vi.fn(),
    mockAssertUserAccountInGoodStanding: vi.fn(),
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
  assertUserAccountInGoodStanding: mockAssertUserAccountInGoodStanding,
}));

vi.mock('~/server/services/challenge-category.service', () => ({
  resolveJudgingCategories: mockResolveJudgingCategories,
}));

// Judge validation (read/write parity with the picker) runs before the standing gate; must
// include editInput.judgeId so these tests exercise the standing checks, not judge lookup.
vi.mock('~/server/services/challenge-judge.service', () => ({
  getUserSelectableJudges: vi.fn(() => [{ id: 1 }]),
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
const { getChallengeForEdit, getUserChallengeForEdit, upsertUserChallenge } = await import(
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
    mockDbRead.image.findFirst.mockResolvedValue({ id: 555 });
    mockResolveJudgingCategories.mockResolvedValue([]);
  });

  it('throws when the creator has fallen out of good standing (muted/struck/banned)', async () => {
    mockAssertUserAccountInGoodStanding.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Muted accounts cannot create challenges.' })
    );

    await expect(upsertUserChallenge(editInput as never)).rejects.toThrow(
      'Muted accounts cannot create challenges.'
    );

    expect(mockAssertUserAccountInGoodStanding).toHaveBeenCalledWith(111);
    // Score/cap/daily-limit gates are create-only concerns — must not run on edit.
    expect(mockAssertCanCreateUserChallenge).not.toHaveBeenCalled();
    expect(mockAssertUserInGoodStanding).not.toHaveBeenCalled();
    // Standing gate sits before the existing-challenge/cover-image lookups, so a since-muted
    // creator can't trigger those side effects.
    expect(mockDbRead.challenge.findUnique).not.toHaveBeenCalled();
    expect(mockDbRead.image.findFirst).not.toHaveBeenCalled();
  });

  it('does not throw on the standing check when the creator is in good standing', async () => {
    mockAssertUserAccountInGoodStanding.mockResolvedValueOnce({
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

    expect(mockAssertUserAccountInGoodStanding).toHaveBeenCalledWith(111);
    expect(mockAssertCanCreateUserChallenge).not.toHaveBeenCalled();
    // The edit branch must never reach for the score-bundled check.
    expect(mockAssertUserInGoodStanding).not.toHaveBeenCalled();
  });
});

describe('getUserChallengeForEdit — ownership/moderator gate', () => {
  const guardRow = {
    source: 'User' as const,
    createdById: 111,
    status: 'Scheduled' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeConfig.mockResolvedValue(mockConfig);
    mockDbRead.$queryRaw.mockResolvedValue([
      { id: 111, username: 'creator', image: null, deletedAt: null },
    ]);
    mockDbRead.challenge.findUnique.mockResolvedValue(guardRow);
    mockGetChallengeById.mockResolvedValue(
      makeMockChallenge({ source: 'User', createdById: 111, status: 'Scheduled' })
    );
  });

  it('returns the challenge for its owner', async () => {
    const result = await getUserChallengeForEdit({ id: 1, userId: 111 });
    expect(result?.id).toBe(1);
  });

  it('returns the challenge for a moderator who is not the owner', async () => {
    const result = await getUserChallengeForEdit({ id: 1, userId: 222, isModerator: true });
    expect(result?.id).toBe(1);
  });

  it('rejects a non-owner without moderator status', async () => {
    await expect(getUserChallengeForEdit({ id: 1, userId: 222 })).rejects.toThrow(
      'You can only edit your own challenges.'
    );
  });

  it('rejects non-User challenges even for moderators (mod form owns those)', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue({ ...guardRow, source: 'System' });
    await expect(
      getUserChallengeForEdit({ id: 1, userId: 222, isModerator: true })
    ).rejects.toThrow('This challenge cannot be edited here.');
  });
});

describe('upsertUserChallenge — schedule limits', () => {
  // Minimal input: schedule checks run before judge/standing/DB lookups, so most fields are unused.
  // judgingCategories still carries a contract-valid shape (theme once, weights sum 100) so the
  // fixture stays representative if the service ever validates it before the schedule gate.
  const baseInput = {
    userId: 111,
    buzzType: 'yellow' as const,
    title: 'Schedule test',
    description: 'desc',
    theme: 'Neon',
    coverImage: { id: 555, url: 'unused' },
    allowedNsfwLevel: 1,
    modelVersionIds: [],
    judgeId: 1,
    judgingCategories: [{ key: 'theme', label: 'Theme', criteria: 'Fits the theme.', weight: 100 }],
    entryFee: 50,
    initialPrizeBuzz: 0,
    prizeDistribution: [50, 30, 20],
    maxEntriesPerUser: 5,
  };
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a create with a duration under the minimum', async () => {
    const startsAt = new Date(Date.now() + 4 * HOUR);
    await expect(
      upsertUserChallenge({
        ...baseInput,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 23 * HOUR),
      } as never)
    ).rejects.toThrow('Challenge must run for at least 24 hours.');
  });

  it('rejects a create with a duration over the maximum', async () => {
    const startsAt = new Date(Date.now() + 4 * HOUR);
    await expect(
      upsertUserChallenge({
        ...baseInput,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 31 * DAY),
      } as never)
    ).rejects.toThrow('Challenge cannot run longer than 30 days.');
  });

  it('rejects a create starting more than 30 days out', async () => {
    const startsAt = new Date(Date.now() + 31 * DAY);
    await expect(
      upsertUserChallenge({
        ...baseInput,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * DAY),
      } as never)
    ).rejects.toThrow('Challenge cannot start more than 30 days from now.');
  });

  it('does NOT apply the create-path max-future check on an edit', async () => {
    // Stored start > 30d out (e.g. created before the limit existed) and unchanged in the
    // payload. The top-of-function max-future check must be create-only (`!id`) — the call must
    // get past all top-of-function schedule gates and reach the challenge lookup, whose null
    // sentinel produces "Challenge not found".
    const storedStartsAt = new Date(Date.now() + 40 * DAY);
    mockAssertUserAccountInGoodStanding.mockResolvedValueOnce({
      scoreTotal: 0,
      bannedAt: null,
      muted: false,
      deletedAt: null,
      activeStrikes: 0,
    });
    mockDbRead.image.findFirst.mockResolvedValue({ id: 555 });
    mockDbRead.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(
      upsertUserChallenge({
        ...baseInput,
        id: 42,
        startsAt: storedStartsAt,
        endsAt: new Date(storedStartsAt.getTime() + 2 * DAY),
      } as never)
    ).rejects.toThrow('Challenge not found');
  });

  it('rejects an edit that MOVES the start date beyond 30 days out', async () => {
    const storedStartsAt = new Date(Date.now() + 5 * DAY);
    const movedStartsAt = new Date(Date.now() + 35 * DAY);
    mockAssertUserAccountInGoodStanding.mockResolvedValueOnce({
      scoreTotal: 0,
      bannedAt: null,
      muted: false,
      deletedAt: null,
      activeStrikes: 0,
    });
    mockDbRead.image.findFirst.mockResolvedValue({ id: 555 });
    // Row shape mirrors the edit branch's findUnique select (challenge.service.ts:~1477-1492).
    // collectionId: null skips the entry-count query; buzzType/basePrizePool/allowedNsfwLevel
    // clear the currency + green-SFW gates that run before the startChanged check.
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      createdById: 111,
      source: 'User',
      status: 'Scheduled',
      collectionId: null,
      basePrizePool: 0,
      metadata: null,
      buzzType: 'yellow',
      startsAt: storedStartsAt,
      title: 'Schedule test',
      description: 'desc',
      theme: 'Neon',
      invitation: null,
    });

    await expect(
      upsertUserChallenge({
        ...baseInput,
        id: 42,
        startsAt: movedStartsAt,
        endsAt: new Date(movedStartsAt.getTime() + 2 * DAY),
      } as never)
    ).rejects.toThrow('Challenge cannot start more than 30 days from now.');
  });

  it('rejects an edit with a duration over the maximum', async () => {
    const startsAt = new Date(Date.now() + 5 * DAY);
    await expect(
      upsertUserChallenge({
        ...baseInput,
        id: 42,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 31 * DAY),
      } as never)
    ).rejects.toThrow('Challenge cannot run longer than 30 days.');
  });
});
