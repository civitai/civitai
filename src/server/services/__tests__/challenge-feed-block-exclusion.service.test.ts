import type { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// getInfiniteChallenges: user challenges whose creator is in the viewer's block/hide set must be
// dropped from the feed (parity with getChallengeDetail's creator-block gate, covered in
// challenge-detail-visibility.service.test.ts). The predicate is only pushed onto the query when
// the viewer's excluded-id set is non-empty, so we assert both that the predicate appears when it
// should and that it's absent (not just empty) when it shouldn't.
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

// Duck-typed Prisma.Sql detection: the runtime `@prisma/client` package doesn't export the `Sql`
// class itself (only the `Prisma.sql` tag function), so `instanceof Prisma.Sql` isn't available.
// Every Sql fragment (plain or `Prisma.join`-composed) exposes an own `values`/`strings` array
// plus a `.text` getter that already contains the FULLY FLATTENED, fully-composed SQL of any
// nested fragments — so no manual recursion is needed once a fragment is identified.
function isSqlLike(x: unknown): x is Prisma.Sql {
  return (
    typeof x === 'object' &&
    x !== null &&
    Array.isArray((x as { values?: unknown }).values) &&
    Array.isArray((x as { strings?: unknown }).strings) &&
    typeof (x as { text?: unknown }).text === 'string'
  );
}

// Pulls the first `dbRead.$queryRaw` call's tagged-template args (stringsArray + interpolated
// values — `challengeCardQuery`, `whereClause`, `orderByClause`, `limit + 1`), keeps only the
// Prisma.Sql fragments, and flattens them into one SQL text + one bound-values list to assert on.
function captureQuery() {
  const call = mockDbRead.$queryRaw.mock.calls[0];
  if (!call) throw new Error('dbRead.$queryRaw was not called');
  const sqlFragments = call.filter(isSqlLike);
  return {
    text: sqlFragments.map((s) => s.text).join(' '),
    values: sqlFragments.flatMap((s) => s.values),
  };
}

const BLOCK_PREDICATE_MARKER = '!= ALL(';

describe('getInfiniteChallenges — feed block/hide exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockDbRead.image.findMany.mockResolvedValue([]);
    mockHiddenUsersGetCached.mockResolvedValue([]);
    mockBlockedByUsersGetCached.mockResolvedValue([]);
    mockBlockedUsersGetCached.mockResolvedValue([]);
  });

  it("excludes a blocked creator's user challenges", async () => {
    mockBlockedByUsersGetCached.mockResolvedValue([{ id: 777 }]);

    await getInfiniteChallenges({
      limit: 20,
      includeEnded: false,
      excludeEventChallenges: false,
      currentUserId: 5,
      isGreen: false,
      canAccessUserChallenges: true,
    } as Parameters<typeof getInfiniteChallenges>[0]);

    const { text, values } = captureQuery();
    expect(text).toContain(BLOCK_PREDICATE_MARKER);
    expect(values.some((v) => Array.isArray(v) && v.includes(777))).toBe(true);
  });

  it('adds no block predicate when the viewer has no blocks', async () => {
    await getInfiniteChallenges({
      limit: 20,
      includeEnded: false,
      excludeEventChallenges: false,
      currentUserId: 5,
      isGreen: false,
      canAccessUserChallenges: true,
    } as Parameters<typeof getInfiniteChallenges>[0]);

    const { text } = captureQuery();
    expect(text).not.toContain(BLOCK_PREDICATE_MARKER);
  });

  it('anonymous viewer adds no block predicate', async () => {
    await getInfiniteChallenges({
      limit: 20,
      includeEnded: false,
      excludeEventChallenges: false,
      currentUserId: undefined,
      isGreen: false,
      canAccessUserChallenges: true,
    } as Parameters<typeof getInfiniteChallenges>[0]);

    const { text } = captureQuery();
    expect(text).not.toContain(BLOCK_PREDICATE_MARKER);
    expect(mockHiddenUsersGetCached).not.toHaveBeenCalled();
    expect(mockBlockedByUsersGetCached).not.toHaveBeenCalled();
    expect(mockBlockedUsersGetCached).not.toHaveBeenCalled();
  });
});
