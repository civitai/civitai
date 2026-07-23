import type { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// getMyChallenges: pins the WHERE-clause grouping between the "entered" branch (my CTE) and the
// "created" branch (creator id + source = User). Flattening that OR — even by accident while
// editing a neighboring predicate (block exclusion, domain currency, browsing level all live in
// this same WHERE) — would readmit Mod/System-sourced challenges through the creator branch with
// no visible symptom besides a dead "Manage" link for the moderators who created them (see
// challenge.service.ts:454's isCreator scoping). Mocking shape mirrors
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

const { getMyChallenges } = await import('~/server/services/challenge.service');

// Duck-typed Prisma.Sql detection — see challenge-feed-block-exclusion.service.test.ts for why
// `instanceof Prisma.Sql` isn't available at runtime.
function isSqlLike(x: unknown): x is Prisma.Sql {
  return (
    typeof x === 'object' &&
    x !== null &&
    Array.isArray((x as { values?: unknown }).values) &&
    Array.isArray((x as { strings?: unknown }).strings) &&
    typeof (x as { text?: unknown }).text === 'string'
  );
}

function capturedSql(): string {
  const call = mockDbRead.$queryRaw.mock.calls[0];
  if (!call) throw new Error('dbRead.$queryRaw was not called');
  return call
    .filter(isSqlLike)
    .map((s) => s.text)
    .join(' ');
}

describe('getMyChallenges — WHERE-clause scope and grouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockHiddenUsersGetCached.mockResolvedValue([]);
    mockBlockedByUsersGetCached.mockResolvedValue([]);
    mockBlockedUsersGetCached.mockResolvedValue([]);
  });

  it('scopes the created-by branch to User-sourced challenges, grouped under the same OR as the entered branch', async () => {
    await getMyChallenges({ userId: 42, limit: 6, isGreen: false });

    const text = capturedSql().replace(/\$\d+/g, '$?').replace(/\s+/g, ' ');
    expect(text).toContain('OR (c."createdById" = $? AND c.source = $?::"ChallengeSource")');
    // The grouping is what matters: flattening this OR (dropping the inner parens) would let a
    // Mod/System-sourced challenge with a viewer CollectionItem satisfy the WHERE via the creator
    // clause without the source guard, which is exactly the silent-failure mode this pins.
    expect(text).toContain('WHERE (my."collectionId" IS NOT NULL OR (');
  });
});
