import { describe, it, expect, vi, beforeEach } from 'vitest';

// Full-stack proof (no eligibility-service mock) that:
//  - EDIT re-checks account standing only — a good-standing owner whose creator score has
//    dipped below CHALLENGE_MIN_CREATOR_SCORE can still edit their own Scheduled challenge.
//  - CREATE still enforces the full gate (standing + score).
// Only the DB layer (dbRead.user / dbRead.userStrike) backing the real eligibility checks is
// mocked, so the actual assertUserAccountInGoodStanding / assertUserInGoodStanding logic runs.
const { mockDbRead, mockGetChallengeConfig, mockResolveJudgingCategories } = vi.hoisted(() => {
  return {
    mockDbRead: {
      $queryRaw: vi.fn(),
      user: { findUnique: vi.fn() },
      userStrike: { count: vi.fn() },
      modelVersion: { findMany: vi.fn() },
      image: { findUnique: vi.fn(), findFirst: vi.fn() },
      challenge: { findUnique: vi.fn(), count: vi.fn() },
    },
    mockGetChallengeConfig: vi.fn(),
    mockResolveJudgingCategories: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(() => null),
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
  getChallengeById: vi.fn(),
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

vi.mock('~/server/services/challenge-category.service', () => ({
  resolveJudgingCategories: mockResolveJudgingCategories,
}));

// Judge validation (read/write parity with the picker) runs before the standing gate; must
// include baseInput.judgeId so these tests exercise the eligibility checks, not judge lookup.
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

const { upsertUserChallenge } = await import('~/server/services/challenge.service');

const GOOD_USER = {
  meta: { scores: { total: 0 } }, // below CHALLENGE_MIN_CREATOR_SCORE (5000) on purpose
  bannedAt: null as Date | null,
  muted: false,
  deletedAt: null as Date | null,
};

function mockUser(overrides: Partial<typeof GOOD_USER> = {}) {
  mockDbRead.user.findUnique.mockResolvedValueOnce({ ...GOOD_USER, ...overrides });
}

const USER_ID = 111;
const FAR_FUTURE_STARTS_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const FAR_FUTURE_ENDS_AT = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

const baseInput = {
  userId: USER_ID,
  buzzType: 'yellow' as const,
  title: 'Title',
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
  startsAt: FAR_FUTURE_STARTS_AT,
  endsAt: FAR_FUTURE_ENDS_AT,
};

describe('upsertUserChallenge — real eligibility gate (no mocked assert* functions)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.image.findFirst.mockResolvedValue({ id: 555 });
    mockDbRead.userStrike.count.mockResolvedValue(0);
    mockResolveJudgingCategories.mockResolvedValue([]);
  });

  it('EDIT: a below-score-but-good-standing owner CAN edit (standing-only gate passes)', async () => {
    mockUser(); // scoreTotal: 0, otherwise clean
    // Downstream of the eligibility gate: challenge no longer exists, so the only way to reach
    // this rejection is by first clearing the real (unmocked) standing-only check.
    mockDbRead.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(
      upsertUserChallenge({ ...baseInput, id: 42 } as never)
    ).rejects.toThrow('Challenge not found');
  });

  it('EDIT: a muted owner is still blocked (account standing enforced)', async () => {
    mockUser({ muted: true });

    await expect(upsertUserChallenge({ ...baseInput, id: 42 } as never)).rejects.toThrow(
      'Muted accounts cannot create challenges.'
    );
    // Never reached the existing-challenge lookup — standing gate runs first.
    expect(mockDbRead.challenge.findUnique).not.toHaveBeenCalled();
  });

  it('EDIT: a banned owner is still blocked (account standing enforced)', async () => {
    mockUser({ bannedAt: new Date() });

    await expect(upsertUserChallenge({ ...baseInput, id: 42 } as never)).rejects.toThrow(
      'Your account is not eligible to create challenges.'
    );
  });

  it('EDIT: an owner with an active strike is still blocked (account standing enforced)', async () => {
    mockUser();
    mockDbRead.userStrike.count.mockResolvedValueOnce(1);

    await expect(upsertUserChallenge({ ...baseInput, id: 42 } as never)).rejects.toThrow(
      'Resolve your active strikes before creating a challenge.'
    );
  });

  it('CREATE: a below-score creator is still blocked (full gate, score included)', async () => {
    mockUser(); // scoreTotal: 0, good standing otherwise

    await expect(upsertUserChallenge({ ...baseInput } as never)).rejects.toThrow(
      'You need a creator score of at least 5,000 to create challenges.'
    );
  });
});
