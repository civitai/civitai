import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FliptClient from '~/server/flipt/client';
const mockDbReadQueryRaw = dbMock.dbRead.$queryRaw;
const mockDbWriteQueryRaw = dbMock.dbWrite.$queryRaw;
const mockDbWriteExecuteRaw = dbMock.dbWrite.$executeRaw;
const mockDbWriteExecuteRawUnsafe = dbMock.dbWrite.$executeRawUnsafe;
dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

// Replay window on reviewEntriesForChallenge: a replay reviews one tick's arrivals and must not
// move the review watermark. Mocks mirror the judging-categories suite.

const {
  mockIsFlipt,
  mockGetChallengeConfig,
  mockGetJudgingConfig,
  mockEndChallenge,
  mockGetActiveChallenges,
  mockGenerateReview,
  mockGenerateWinners,
  mockClaimChallengeForCompletion,
  mockGetExistingWinnersForRetry,
  mockResolveEventContext,
  mockUpdateChallengeStatus,
  mockRefundUserChallengeFunds,
  mockCreateNotification,
} = vi.hoisted(() => ({
  // Final-prize recompute reads prizePool/prizeDistribution on the User path; null distribution
  // skips the recompute so these tests exercise the judging gate unchanged.
  mockIsFlipt: vi.fn().mockResolvedValue(false),
  mockGetChallengeConfig: vi.fn(),
  mockGetJudgingConfig: vi.fn(),
  mockEndChallenge: vi.fn().mockResolvedValue(undefined),
  mockGetActiveChallenges: vi.fn(),
  mockGenerateReview: vi.fn(),
  mockGenerateWinners: vi.fn(),
  mockClaimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  mockGetExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  mockResolveEventContext: vi.fn().mockResolvedValue(undefined),
  mockUpdateChallengeStatus: vi.fn().mockResolvedValue(undefined),
  mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
}));

// Cuts the eventEngine -> clickhouse/redis/discord transitive chain. Only
// reviewEntriesForChallenge's event-engagement branch calls this.
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return { ...actual, isFlipt: mockIsFlipt };
});

// daily-challenge.utils re-exports calculateWeightedScore/SCORE_WEIGHTS from the
// dependency-free daily-challenge-scoring module — pull the real ones in so the fixed-rubric
// path under test uses actual production math, while everything else on this module (which
// pulls sysRedis/DB) is stubbed.
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async () => {
  const real = await import('~/server/games/daily-challenge/daily-challenge-scoring');
  return {
    SCORE_WEIGHTS: real.SCORE_WEIGHTS,
    calculateWeightedScore: real.calculateWeightedScore,
    challengeToLegacyFormat: vi.fn(),
    deriveChallengeNsfwLevel: vi.fn(() => 1),
    endChallenge: mockEndChallenge,
    getActiveChallenges: mockGetActiveChallenges,
    getChallengeConfig: mockGetChallengeConfig,
    getJudgingConfig: mockGetJudgingConfig,
    getUpcomingSystemChallenge: vi.fn(),
  };
});

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  challengeClaimStillHeld: vi.fn().mockResolvedValue(true),
  completeChallengeIfClaimHeld: vi.fn().mockResolvedValue(true),
  claimChallengeForCompletion: mockClaimChallengeForCompletion,
  computeDynamicPool: vi.fn(),
  distributePrizes: vi.fn(),
  createChallengeRecord: vi.fn(),
  createChallengeWinner: vi.fn().mockResolvedValue(undefined),
  getChallengeById: vi.fn(),
  getChallengeEntryCount: vi.fn().mockResolvedValue(0),
  getExistingWinnersForRetry: mockGetExistingWinnersForRetry,
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
  resolveEventContext: mockResolveEventContext,
  setChallengeActive: vi.fn(),
  updateChallengeStatus: mockUpdateChallengeStatus,
}));

vi.mock('~/server/games/daily-challenge/challenge-rewards', () => ({
  distributeParticipationPrizes: vi.fn().mockResolvedValue([]),
  promoteChallengeEntries: vi.fn().mockResolvedValue(0),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  REVIEW_FALLBACK_MODEL: 'fallback-model',
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateArticle: vi.fn(),
  generateCollectionDetails: vi.fn(),
  generateReview: mockGenerateReview,
  generateWinners: mockGenerateWinners,
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  getTransactionByExternalId: vi.fn().mockResolvedValue(null),
}));

vi.mock('~/server/services/commentsv2.service', () => ({
  upsertComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
  getChallengeBuzzType: vi.fn(async () => 'yellow'),
  buildWinnerPrizes: vi.fn(() => []),
  reportPoolFundingShortfall: vi.fn(),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { challengeReviewInternals } = await import('~/server/jobs/daily-challenge-processing');
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');
const { Prisma } = await import('@prisma/client');

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

const JUDGING_CONFIG = {
  judgeId: 1,
  userId: 999,
  sourceCollectionId: null,
  prompts: {},
  reviewTemplate: null,
} as never;

const CATEGORIES = [
  { key: 'theme', weight: 60, label: 'Theme', criteria: 'fits the theme' },
  { key: 'aesthetic', weight: 40, label: 'Aesthetic', criteria: 'looks good' },
];

const challenge = {
  challengeId: 1,
  collectionId: 100,
  type: 'daily',
  date: new Date('2026-10-23T00:00:00Z'),
  theme: 'test',
  modelId: 1,
  modelVersionIds: [1],
  title: 'Test',
  invitation: '',
  coverUrl: '',
  prizes: [],
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 0, points: 0 },
} as never;

const from = new Date('2026-10-23T05:00:00Z');
const to = new Date('2026-10-23T05:10:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWriteExecuteRaw.mockResolvedValue(1);
  mockGetChallengeConfig.mockResolvedValue(BASE_CONFIG);
  mockGetJudgingConfig.mockResolvedValue(JUDGING_CONFIG);
  mockIsFlipt.mockResolvedValue(false);

  // dbRead.$queryRaw order: challengeRecord, rejectedUsers, challengeReviewState.
  mockDbReadQueryRaw
    .mockResolvedValueOnce([
      {
        allowedNsfwLevel: 1,
        judgeId: null,
        judgingPrompt: null,
        prizeMode: 'Fixed',
        prizePool: 0,
        basePrizePool: 0,
        buzzPerAction: 0,
        poolTrigger: null,
        maxPrizePool: null,
        prizeDistribution: null,
        metadata: null,
        source: ChallengeSource.System,
        judgingCategories: CATEGORIES,
        entryFee: 0,
      },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ reviewedAt: new Date('2026-10-23T04:50:00Z').getTime() }]);
  dbMock.dbRead.challenge.findUnique.mockResolvedValue({ reviewCostType: 'None', reviewCost: 0 });

  // dbWrite.$queryRaw order: userScoredCounts, recentEntries, requestReview, alreadyReviewed
  // guard, earnedPrizes.
  mockDbWriteQueryRaw
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      { imageId: 1, userId: 100, username: 'alice', url: 'http://img/1.jpg' },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ exists: false }])
    .mockResolvedValueOnce([]);

  mockGenerateReview.mockResolvedValue({
    score: { theme: 8, aesthetic: 8, humor: 8, wittiness: 8 },
    summary: 'summary',
    comment: 'nice',
    reaction: 'Like',
  });
});

function recentEntriesQuery() {
  const [strings, ...values] = mockDbWriteQueryRaw.mock.calls[1] as [
    TemplateStringsArray,
    ...unknown[]
  ];
  const { sql, values: bound } = Prisma.sql(strings, ...values);
  return { sql, bound };
}

function watermarkWrites() {
  return mockDbWriteExecuteRawUnsafe.mock.calls.filter(([sql]) =>
    String(sql).includes('"reviewedAt"')
  );
}

describe('reviewEntriesForChallenge replay window', () => {
  it('bounds the candidate pool to the window and drops the watermark lower bound', async () => {
    await challengeReviewInternals.reviewEntriesForChallenge(challenge, {
      replayWindow: { from, to },
    });

    const { sql, bound } = recentEntriesQuery();
    expect(sql).toContain('ci."reviewedAt" >= ?');
    expect(sql).toContain('ci."reviewedAt" < ?');
    expect(bound).toContain(from);
    expect(bound).toContain(to);
    expect(bound.map((v) => (v instanceof Date ? v.getTime() : v))).not.toContain(
      new Date('2026-10-23T04:50:00Z').getTime()
    );
    expect(mockGenerateReview).toHaveBeenCalledTimes(1);
  });

  it('does not move the review watermark', async () => {
    await challengeReviewInternals.reviewEntriesForChallenge(challenge, {
      replayWindow: { from, to },
    });

    expect(watermarkWrites()).toHaveLength(0);
  });

  it('without a window, keeps the watermark lower bound and stamps the watermark', async () => {
    await challengeReviewInternals.reviewEntriesForChallenge(challenge);

    const { sql, bound } = recentEntriesQuery();
    expect(sql).toContain('ci."reviewedAt" >= ?');
    expect(sql).not.toContain('ci."reviewedAt" < ?');
    expect(bound.map((v) => (v instanceof Date ? v.getTime() : v))).toContain(
      new Date('2026-10-23T04:50:00Z').getTime()
    );
    expect(watermarkWrites()).toHaveLength(1);
  });
});
