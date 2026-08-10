import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

// #3774: winning a Community (source=User) challenge put the user on the System Daily winner
// cooldown. `getJudgedEntries` already skipped the cooldown when the challenge being judged is
// source=User, but the lookback query never filtered the source of the WINS it counted, so a
// Community win disqualified the user from Daily prizes for 7 days.
//
// Same mock preamble as daily-challenge-processing.judging-categories.test.ts: `~/server/events`
// and the heavy service modules are cut so daily-challenge-processing can load, while the pure
// ranking/cooldown helpers stay real.

const {
  mockDbReadQueryRaw,
  mockDbReadChallengeFindUnique,
  mockDbWriteQueryRaw,
  mockDbWriteExecuteRaw,
  mockDbWriteChallengeUpdate,
  mockDbWriteChallengeFindUnique,
  mockIsFlipt,
  mockGetChallengeConfig,
  mockGetJudgingConfig,
} = vi.hoisted(() => ({
  mockDbReadQueryRaw: vi.fn(),
  mockDbReadChallengeFindUnique: vi.fn(),
  mockDbWriteQueryRaw: vi.fn(),
  mockDbWriteExecuteRaw: vi.fn().mockResolvedValue(1),
  mockDbWriteChallengeUpdate: vi.fn().mockResolvedValue(undefined),
  mockDbWriteChallengeFindUnique: vi.fn().mockResolvedValue({
    prizePool: 0,
    prizeDistribution: null,
  }),
  mockIsFlipt: vi.fn().mockResolvedValue(false),
  mockGetChallengeConfig: vi.fn(),
  mockGetJudgingConfig: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    $queryRaw: mockDbReadQueryRaw,
    challenge: { findUnique: mockDbReadChallengeFindUnique },
  },
  dbWrite: {
    $queryRaw: mockDbWriteQueryRaw,
    $executeRaw: mockDbWriteExecuteRaw,
    challenge: { update: mockDbWriteChallengeUpdate, findUnique: mockDbWriteChallengeFindUnique },
  },
}));

vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return { ...actual, isFlipt: mockIsFlipt };
});

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async () => {
  const real = await import('~/server/games/daily-challenge/daily-challenge-scoring');
  return {
    SCORE_WEIGHTS: real.SCORE_WEIGHTS,
    calculateWeightedScore: real.calculateWeightedScore,
    challengeToLegacyFormat: vi.fn(),
    deriveChallengeNsfwLevel: vi.fn(() => 1),
    endChallenge: vi.fn().mockResolvedValue(undefined),
    getActiveChallenges: vi.fn(),
    getChallengeConfig: mockGetChallengeConfig,
    getJudgingConfig: mockGetJudgingConfig,
    getUpcomingSystemChallenge: vi.fn(),
  };
});

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  claimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  computeDynamicPool: vi.fn(),
  distributePrizes: vi.fn(),
  createChallengeRecord: vi.fn(),
  createChallengeWinner: vi.fn().mockResolvedValue(undefined),
  getChallengeById: vi.fn(),
  getChallengeEntryCount: vi.fn().mockResolvedValue(0),
  getExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
  resolveEventContext: vi.fn().mockResolvedValue(undefined),
  setChallengeActive: vi.fn(),
  updateChallengeStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-rewards', () => ({
  distributeParticipationPrizes: vi.fn().mockResolvedValue([]),
  promoteChallengeEntries: vi.fn().mockResolvedValue(0),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateArticle: vi.fn(),
  generateCollectionDetails: vi.fn(),
  generateReview: vi.fn(),
  generateWinners: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  getTransactionByExternalId: vi.fn().mockResolvedValue(null),
}));

vi.mock('~/server/services/commentsv2.service', () => ({
  upsertComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  refundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  getChallengeBuzzType: vi.fn(async () => 'yellow'),
  buildWinnerPayoutTransactions: vi.fn(() => []),
  reportPoolFundingShortfall: vi.fn(),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { getJudgedEntries } = await import('~/server/jobs/daily-challenge-processing');
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');

const BASE_CONFIG = {
  challengeType: 'world-morph',
  challengeCollectionId: 1,
  judgedTagId: 11,
  reviewMeTagId: 12,
  userCooldown: '14 day',
  resourceCooldown: '90 day',
  winnerCooldown: '7 day',
  prizes: [],
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 0, points: 0 },
  reviewAmount: { min: 6, max: 12 },
  maxScoredPerUser: 5,
  finalReviewAmount: 10,
  resourceCosmeticId: null,
  articleTagId: 1,
  defaultJudgeId: 1,
  defaultJudge: null,
} as never;

function judgedEntry(userId: number, username: string, imageId: number) {
  return {
    imageId,
    userId,
    username,
    note: JSON.stringify({
      score: { theme: 10, aesthetic: 10, humor: 10, wittiness: 10 },
      summary: `entry from ${username}`,
    }),
  };
}

function cooldownSql() {
  return (mockDbWriteQueryRaw.mock.calls[0][0] as unknown as string[]).join('');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChallengeConfig.mockResolvedValue(BASE_CONFIG);
  mockDbReadQueryRaw.mockResolvedValue([judgedEntry(100, 'alice', 1)]);
  mockDbWriteQueryRaw.mockResolvedValue([]);
});

describe('getJudgedEntries — winner cooldown ignores user-challenge wins', () => {
  it('excludes user-sourced wins from the global cooldown lookback', async () => {
    await getJudgedEntries(100, BASE_CONFIG, undefined, ChallengeSource.System, undefined);

    expect(mockDbWriteQueryRaw).toHaveBeenCalledTimes(1);
    expect(cooldownSql()).toMatch(/c\."source"\s*<>\s*'User'/);
  });

  it('excludes user-sourced wins from the event-scoped cooldown lookback', async () => {
    await getJudgedEntries(
      100,
      BASE_CONFIG,
      { eventId: 7, winnerCooldownDays: 14 },
      ChallengeSource.System,
      undefined
    );

    expect(mockDbWriteQueryRaw).toHaveBeenCalledTimes(1);
    expect(cooldownSql()).toMatch(/c\."source"\s*<>\s*'User'/);
  });

  it('still drops entrants the lookback reports as recent winners', async () => {
    // Two entrants so filterRecentWinners' all-on-cooldown fallback can't mask the filtering.
    mockDbReadQueryRaw.mockResolvedValue([
      judgedEntry(100, 'alice', 1),
      judgedEntry(200, 'bob', 2),
    ]);
    mockDbWriteQueryRaw.mockResolvedValue([{ userId: 100 }]);

    const result = await getJudgedEntries(
      100,
      BASE_CONFIG,
      undefined,
      ChallengeSource.System,
      undefined
    );

    expect(result.map((e) => e.userId)).toEqual([200]);
  });
});
