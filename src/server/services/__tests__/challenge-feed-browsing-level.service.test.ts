import type { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// getInfiniteChallenges: the content-level gate must test the CHALLENGE's own rating
// (`Challenge.nsfwLevel` — the single highest level its `allowedNsfwLevel` permits) and not only
// the cover image's level. Filtering on the cover alone let an X-rated challenge with an SFW cover
// surface for a PG/PG-13 viewer. The cover predicate stays alongside it so a challenge that
// under-declares its rating still can't leak an NSFW cover into an SFW feed. Mocking shape mirrors
// challenge-feed-block-exclusion.service.test.ts.
const {
  mockDbRead,
  mockHiddenUsersGetCached,
  mockBlockedByUsersGetCached,
  mockBlockedUsersGetCached,
} = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(),
    modelVersion: { findMany: vi.fn() },
    image: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(() => []) },
    challenge: { findUnique: vi.fn() },
    collectionItem: { count: vi.fn() },
  },
  mockHiddenUsersGetCached: vi.fn(() => [] as { id: number }[]),
  mockBlockedByUsersGetCached: vi.fn(() => [] as { id: number }[]),
  mockBlockedUsersGetCached: vi.fn(() => [] as { id: number }[]),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenUsers: { getCached: mockHiddenUsersGetCached },
  BlockedByUsers: { getCached: mockBlockedByUsersGetCached },
  BlockedUsers: { getCached: mockBlockedUsersGetCached },
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
  amIBlockedByUser: vi.fn(),
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

const { getInfiniteChallenges } = await import('~/server/services/challenge.service');

// See challenge-feed-block-exclusion.service.test.ts for why Prisma.Sql is duck-typed rather than
// detected with instanceof.
function isSqlLike(x: unknown): x is Prisma.Sql {
  return (
    typeof x === 'object' &&
    x !== null &&
    Array.isArray((x as { values?: unknown }).values) &&
    Array.isArray((x as { strings?: unknown }).strings) &&
    typeof (x as { text?: unknown }).text === 'string'
  );
}

function captureQuery() {
  const call = mockDbRead.$queryRaw.mock.calls[0];
  if (!call) throw new Error('dbRead.$queryRaw was not called');
  const sqlFragments = call.filter(isSqlLike);
  return {
    text: sqlFragments.map((s) => s.text).join(' '),
    values: sqlFragments.flatMap((s) => s.values),
  };
}

const CHALLENGE_LEVEL_PREDICATE = 'c."nsfwLevel" &';
const COVER_LEVEL_PREDICATE = 'i."nsfwLevel" &';

describe('getInfiniteChallenges — content level filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockDbRead.image.findMany.mockResolvedValue([]);
    mockHiddenUsersGetCached.mockResolvedValue([]);
    mockBlockedByUsersGetCached.mockResolvedValue([]);
    mockBlockedUsersGetCached.mockResolvedValue([]);
  });

  it("gates on the challenge's own level as well as the cover's", async () => {
    await getInfiniteChallenges({
      limit: 20,
      includeEnded: false,
      excludeEventChallenges: false,
      canAccessUserChallenges: true,
      currentUserId: 5,
      isGreen: false,
      browsingLevel: 7, // PG | PG13 | R
    } as Parameters<typeof getInfiniteChallenges>[0]);

    const { text, values } = captureQuery();
    expect(text).toContain(CHALLENGE_LEVEL_PREDICATE);
    expect(text).toContain(COVER_LEVEL_PREDICATE);
    expect(values.filter((v) => v === 7).length).toBeGreaterThanOrEqual(2);
  });

  it('applies the same gate to anonymous viewers', async () => {
    await getInfiniteChallenges({
      limit: 20,
      includeEnded: false,
      excludeEventChallenges: false,
      canAccessUserChallenges: true,
      isGreen: false,
      browsingLevel: 7,
    } as Parameters<typeof getInfiniteChallenges>[0]);

    const { text } = captureQuery();
    expect(text).toContain(CHALLENGE_LEVEL_PREDICATE);
    expect(text).toContain(COVER_LEVEL_PREDICATE);
  });

  it('caps the level on green even when the client asks for NSFW', async () => {
    await getInfiniteChallenges({
      limit: 20,
      includeEnded: false,
      excludeEventChallenges: false,
      canAccessUserChallenges: true,
      currentUserId: 5,
      isGreen: true,
      browsingLevel: 31, // asks for everything; masked to the SFW cap (PG | PG13)
    } as Parameters<typeof getInfiniteChallenges>[0]);

    const { text, values } = captureQuery();
    expect(text).toContain(CHALLENGE_LEVEL_PREDICATE);
    expect(values).toContain(3);
    expect(values).not.toContain(31);
  });

  it('adds no level predicate off green when no level is requested', async () => {
    await getInfiniteChallenges({
      limit: 20,
      includeEnded: false,
      excludeEventChallenges: false,
      canAccessUserChallenges: true,
      currentUserId: 5,
      isGreen: false,
    } as Parameters<typeof getInfiniteChallenges>[0]);

    const { text } = captureQuery();
    expect(text).not.toContain(CHALLENGE_LEVEL_PREDICATE);
    expect(text).not.toContain(COVER_LEVEL_PREDICATE);
  });
});
