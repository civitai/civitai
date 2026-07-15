import { describe, it, expect, vi, beforeEach } from 'vitest';

// Verifies judging-category routing after the DYNAMIC_JUDGING_CATEGORIES flag removal: any
// challenge with a valid judgingCategories value is judged/ranked by it regardless of source.
// `getJudgedEntries` routes on the presence of `categories`, not `source`; the two
// daily-challenge-processing.ts call sites (review: reviewEntriesForChallenge via reviewEntries();
// rank: pickWinnersForChallenge) parse judgingCategories unconditionally. Malformed/null falls back.
//
// `~/server/events` is mocked to cut off its heavy transitive chain (clickhouse/redis/discord) —
// daily-challenge-processing.ts imports it at module scope but only calls it from
// reviewEntriesForChallenge's event-engagement branch. Everything else that's pure/dependency-free
// (daily-challenge-scoring, winner-cooldown, concurrency-helpers, array/number/type-guard utils) is
// left real so the ranking math under test is the actual production math.

const {
  mockDbReadQueryRaw,
  mockDbReadChallengeFindUnique,
  mockDbWriteQueryRaw,
  mockDbWriteExecuteRaw,
  mockDbWriteChallengeUpdate,
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
  mockDbWriteChallengeFindUnique,
} = vi.hoisted(() => ({
  mockDbReadQueryRaw: vi.fn(),
  mockDbReadChallengeFindUnique: vi.fn(),
  mockDbWriteQueryRaw: vi.fn(),
  mockDbWriteExecuteRaw: vi.fn().mockResolvedValue(1),
  mockDbWriteChallengeUpdate: vi.fn().mockResolvedValue(undefined),
  // Final-prize recompute reads prizePool/prizeDistribution on the User path; null distribution
  // skips the recompute so these tests exercise the judging gate unchanged.
  mockDbWriteChallengeFindUnique: vi.fn().mockResolvedValue({
    prizePool: 0,
    prizeDistribution: null,
  }),
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

// Cuts the eventEngine -> clickhouse/redis/discord transitive chain. Only
// reviewEntriesForChallenge's event-engagement branch calls this.
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
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
  buildWinnerPayoutTransactions: vi.fn(() => []),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const {
  getJudgedEntries,
  pickWinnersForChallenge,
  reviewEntries,
} = await import('~/server/jobs/daily-challenge-processing');
const { FLIPT_FEATURE_FLAGS } = await import('~/server/flipt/client');
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');

const VALID_CATEGORIES = [
  { key: 'theme', weight: 60, label: 'Theme', criteria: 'fits the theme' },
  { key: 'aesthetic', weight: 40, label: 'Aesthetic', criteria: 'looks good' },
];
const MALFORMED_CATEGORIES = [{ key: 'theme', weight: 150, label: 'Theme', criteria: 'x' }];

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

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWriteExecuteRaw.mockResolvedValue(1);
  mockGetChallengeConfig.mockResolvedValue(BASE_CONFIG);
  mockGetJudgingConfig.mockResolvedValue(JUDGING_CONFIG);
  mockEndChallenge.mockResolvedValue(undefined);
  mockClaimChallengeForCompletion.mockResolvedValue(true);
  mockGetExistingWinnersForRetry.mockResolvedValue([]);
  mockResolveEventContext.mockResolvedValue(undefined);
  mockUpdateChallengeStatus.mockResolvedValue(undefined);
  mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 0 });
  mockDbWriteChallengeFindUnique.mockResolvedValue({ prizePool: 0, prizeDistribution: null });
  // reviewEntries() gates on CHALLENGE_PLATFORM_ENABLED first; keep it on. No other flags read.
  mockIsFlipt.mockImplementation(
    async (flag: string) => flag === FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED
  );
});

describe('getJudgedEntries — routes on categories presence, not source', () => {
  const config = BASE_CONFIG;

  function mockOneRow() {
    mockDbReadQueryRaw.mockResolvedValueOnce([
      {
        imageId: 1,
        userId: 100,
        username: 'alice',
        note: JSON.stringify({
          score: { theme: 10, aesthetic: 0, humor: 0, wittiness: 0 },
          summary: 'entry A',
        }),
      },
    ]);
  }

  it('System source + categories present: uses the weighted-category path (post-fix — previously required User source)', async () => {
    mockOneRow();
    mockDbWriteQueryRaw.mockResolvedValueOnce([]); // winner-cooldown (global) query
    const result = await getJudgedEntries(
      100,
      config,
      undefined,
      ChallengeSource.System,
      [
        { key: 'theme', weight: 60, label: 'Theme', criteria: 'x' },
        { key: 'aesthetic', weight: 40, label: 'Aesthetic', criteria: 'x' },
      ] as never
    );
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(100);
  });

  it('User source + categories present: still uses the weighted-category path (unchanged)', async () => {
    mockOneRow();
    // No winner-cooldown prime: user challenges skip the cooldown query entirely.
    const result = await getJudgedEntries(
      100,
      config,
      undefined,
      ChallengeSource.User,
      [{ key: 'theme', weight: 100, label: 'Theme', criteria: 'x' }] as never
    );
    expect(result).toHaveLength(1);
    expect(mockDbWriteQueryRaw).not.toHaveBeenCalled();
  });

  it('categories undefined (any source): falls back to the fixed rubric, deduped via SQL ROW_NUMBER', async () => {
    mockOneRow();
    mockDbWriteQueryRaw.mockResolvedValueOnce([]); // winner-cooldown (global) query
    const result = await getJudgedEntries(100, config, undefined, ChallengeSource.System, undefined);
    expect(result).toHaveLength(1);
    // Fixed path's SQL uses ROW_NUMBER() for best-per-user dedup; categories path doesn't.
    const sql = (mockDbReadQueryRaw.mock.calls[0][0] as unknown as string[]).join('');
    expect(sql).toContain('ROW_NUMBER');
  });

  it('empty categories array (defensive): treated as no categories -> fixed rubric', async () => {
    mockOneRow();
    // No winner-cooldown prime: user challenges skip the cooldown query entirely.
    const result = await getJudgedEntries(100, config, undefined, ChallengeSource.User, []);
    expect(result).toHaveLength(1);
    const sql = (mockDbReadQueryRaw.mock.calls[0][0] as unknown as string[]).join('');
    expect(sql).toContain('ROW_NUMBER');
  });
});

describe('pickWinnersForChallenge — judging-category gate', () => {
  const currentChallenge = {
    challengeId: 1,
    type: 'daily',
    date: new Date(),
    theme: 'test',
    modelId: 1,
    modelVersionIds: [1],
    collectionId: 100,
    title: 'Test',
    invitation: '',
    coverUrl: '',
    prizes: [],
    entryPrizeRequirement: 10,
    entryPrize: { buzz: 0, points: 0 },
  } as never;

  function mockChallengeJudgeRow(source: string, judgingCategories: unknown) {
    mockDbReadQueryRaw.mockResolvedValueOnce([
      { judgeId: null, judgingPrompt: null, eventId: null, source, judgingCategories },
    ]);
    // getJudgedEntries's userBestEntries query — empty is enough; we only need to observe
    // which SQL variant it sent (categories vs fixed), not rank real winners.
    mockDbReadQueryRaw.mockResolvedValueOnce([]);
  }

  function secondQuerySql() {
    return (mockDbReadQueryRaw.mock.calls[1][0] as unknown as string[]).join('');
  }

  it('User source + categories: uses the weighted-category path', async () => {
    mockChallengeJudgeRow(ChallengeSource.User, VALID_CATEGORIES);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(secondQuerySql()).not.toContain('ROW_NUMBER');
    expect(mockRefundUserChallengeFunds).toHaveBeenCalledWith(1);
  });

  it('System source + categories: uses the weighted-category path (no source gate)', async () => {
    mockChallengeJudgeRow(ChallengeSource.System, VALID_CATEGORIES);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(secondQuerySql()).not.toContain('ROW_NUMBER');
    expect(mockRefundUserChallengeFunds).not.toHaveBeenCalled();
  });

  it('Mod source + categories: uses the weighted-category path', async () => {
    mockChallengeJudgeRow(ChallengeSource.Mod, VALID_CATEGORIES);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(secondQuerySql()).not.toContain('ROW_NUMBER');
  });

  it('malformed categories fall back to the fixed rubric (User source)', async () => {
    mockChallengeJudgeRow(ChallengeSource.User, MALFORMED_CATEGORIES);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(secondQuerySql()).toContain('ROW_NUMBER');
  });

  it('null categories fall back to the fixed rubric (System source)', async () => {
    mockChallengeJudgeRow(ChallengeSource.System, null);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(secondQuerySql()).toContain('ROW_NUMBER');
  });
});

describe('reviewEntriesForChallenge (via reviewEntries) — judging-category gate', () => {
  const activeChallenge = {
    challengeId: 1,
    collectionId: 100,
    type: 'daily',
    date: new Date(),
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

  function mockReviewSequence(source: string, judgingCategories: unknown) {
    mockGetActiveChallenges.mockResolvedValue([activeChallenge]);

    // dbRead.$queryRaw call order inside reviewEntriesForChallenge (reviewCostType: 'None'
    // below skips the per-entry-refund and flat-rate auto-tag blocks, so these 3 are the total):
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
          source,
          judgingCategories,
        },
      ]) // challengeRecord
      .mockResolvedValueOnce([]) // rejectedUsers
      .mockResolvedValueOnce([]); // challengeReviewState

    mockDbReadChallengeFindUnique.mockResolvedValue({ reviewCostType: 'None', reviewCost: 0 });

    // dbWrite.$queryRaw call order: userScoredCounts, recentEntries (1 entry to review),
    // requestReview (forced review, none), alreadyReviewed-guard (false), earnedPrizes (none).
    mockDbWriteQueryRaw
      .mockResolvedValueOnce([]) // userScoredCounts
      .mockResolvedValueOnce([
        { imageId: 1, userId: 100, username: 'alice', url: 'http://img/1.jpg' },
      ]) // recentEntries
      .mockResolvedValueOnce([]) // requestReview (forced)
      .mockResolvedValueOnce([{ exists: false }]) // alreadyReviewed guard
      .mockResolvedValueOnce([]); // earnedPrizes

    mockGenerateReview.mockResolvedValue({
      score: { theme: 8, aesthetic: 8, humor: 8, wittiness: 8 },
      summary: 'summary',
      comment: 'nice',
      reaction: 'Like',
    });
  }

  it('User source: uses categories', async () => {
    mockReviewSequence(ChallengeSource.User, VALID_CATEGORIES);

    await reviewEntries();

    expect(mockGenerateReview).toHaveBeenCalledTimes(1);
    const arg = mockGenerateReview.mock.calls[0][0];
    expect(arg.categories).toBeDefined();
    expect(arg.categories.map((c: { key: string }) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('System source + categories: uses categories (no source gate)', async () => {
    mockReviewSequence(ChallengeSource.System, VALID_CATEGORIES);

    await reviewEntries();

    const arg = mockGenerateReview.mock.calls[0][0];
    expect(arg.categories).toBeDefined();
    expect(arg.categories.map((c: { key: string }) => c.key)).toEqual(['theme', 'aesthetic']);
  });

  it('Mod source + categories: uses categories', async () => {
    mockReviewSequence(ChallengeSource.Mod, VALID_CATEGORIES);

    await reviewEntries();

    const arg = mockGenerateReview.mock.calls[0][0];
    expect(arg.categories).toBeDefined();
  });

  it('malformed categories fall back to the fixed rubric (User source)', async () => {
    mockReviewSequence(ChallengeSource.User, MALFORMED_CATEGORIES);

    await reviewEntries();

    const arg = mockGenerateReview.mock.calls[0][0];
    expect(arg.categories).toBeUndefined();
  });

  it('null categories fall back to the fixed rubric (System source)', async () => {
    mockReviewSequence(ChallengeSource.System, null);

    await reviewEntries();

    const arg = mockGenerateReview.mock.calls[0][0];
    expect(arg.categories).toBeUndefined();
  });
});
