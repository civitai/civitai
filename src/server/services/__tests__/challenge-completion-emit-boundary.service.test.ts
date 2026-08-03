import { describe, it, expect, vi, beforeEach } from 'vitest';
import client from 'prom-client';
import type { PersistedChallengeWinner } from '~/server/games/daily-challenge/challenge-winner-reconcile';

// Regression coverage for the MOD -> JOB completion boundary.
//
// The bug this locks down: `endChallengeAndPickWinners` (the moderator/tRPC path) used to emit
// `challenge_prize_paid_buzz_total` right next to the winner payout, BEFORE its Completed write.
// Everything between those two points is awaited and throwable (the entry-prize
// `createBuzzTransactionMany`, its `createNotification`, `logToAxiom`) and the catch re-throws, so
// the challenge is left in `Completing`. `resetStuckCompletingChallenges` then flips it back to
// `Active`, the scheduled job claims it, takes the `existingWinners` branch, re-issues the same
// deterministic-id (already-settled) payout, writes Completed and emits. One payout of Buzz, two
// increments of the counter.
//
// This file runs that exact interleaving end to end — real service path, then real job path, one
// shared prom-client registry — and pins the counter to a SINGLE increment. Moving the service
// emit back next to the payout must fail it.
//
// Both modules are imported for real; everything touching DB / LLM / buzz / notifications is mocked
// at the module boundary, so the mock set below is the union of what each module needs.

const {
  mockDbReadQueryRaw,
  mockDbWriteQueryRaw,
  mockDbWriteExecuteRaw,
  mockDbWriteChallengeUpdate,
  mockDbWriteChallengeFindUnique,
  mockClaimChallengeForCompletion,
  mockGetChallengeById,
  mockGetExistingWinnersForRetry,
  mockCreateBuzzTransactionMany,
  mockCreateNotification,
  mockGetChallengeBuzzType,
  mockEndChallenge,
  mockUpdateChallengeStatus,
  mockSendChallengeResultsNotification,
} = vi.hoisted(() => ({
  mockDbReadQueryRaw: vi.fn(),
  mockDbWriteQueryRaw: vi.fn(),
  mockDbWriteExecuteRaw: vi.fn().mockResolvedValue(1),
  mockDbWriteChallengeUpdate: vi.fn().mockResolvedValue(undefined),
  mockDbWriteChallengeFindUnique: vi.fn().mockResolvedValue({
    prizePool: 0,
    prizeDistribution: null,
  }),
  mockClaimChallengeForCompletion: vi.fn(),
  mockGetChallengeById: vi.fn(),
  mockGetExistingWinnersForRetry: vi.fn(),
  mockCreateBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
  mockGetChallengeBuzzType: vi.fn().mockResolvedValue('green'),
  mockEndChallenge: vi.fn().mockResolvedValue(undefined),
  mockUpdateChallengeStatus: vi.fn().mockResolvedValue(undefined),
  mockSendChallengeResultsNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    $queryRaw: mockDbReadQueryRaw,
    challenge: { findUnique: vi.fn() },
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
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(false) };
});

// Spy THROUGH to the real record helpers so assertions read the real registry series.
vi.mock('~/server/prom/challenge.metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/prom/challenge.metrics')>();
  return {
    ...actual,
    recordChallengeCompleted: vi.fn(actual.recordChallengeCompleted),
    recordChallengePrizePaidBuzz: vi.fn(actual.recordChallengePrizePaidBuzz),
  };
});

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async () => {
  const real = await import('~/server/games/daily-challenge/daily-challenge-scoring');
  return {
    SCORE_WEIGHTS: real.SCORE_WEIGHTS,
    calculateWeightedScore: real.calculateWeightedScore,
    challengeToLegacyFormat: vi.fn(),
    deriveChallengeNsfwLevel: vi.fn(() => 1),
    endChallenge: mockEndChallenge,
    getActiveChallenges: vi.fn(),
    getChallengeConfig: vi.fn().mockResolvedValue({ defaultJudgeId: 1, defaultJudge: null }),
    getJudgingConfig: vi.fn().mockResolvedValue({
      judgeId: 1,
      userId: 999,
      sourceCollectionId: null,
      prompts: {},
      reviewTemplate: null,
    }),
    getUpcomingSystemChallenge: vi.fn(),
    setChallengeConfig: vi.fn(),
    refreshDefaultJudgeCache: vi.fn(),
    parseJudgeScore: vi.fn(),
  };
});

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  buildChallengeModerationText: vi.fn(),
  claimChallengeForCompletion: mockClaimChallengeForCompletion,
  closeChallengeCollection: vi.fn().mockResolvedValue(undefined),
  computeDynamicPool: vi.fn(),
  createChallengeRecord: vi.fn(),
  // Resolves to the PERSISTED row, matching the real signature. Inlined rather than built from
  // `persisted-winner.fixture` / `WINNER_PRIZE_BUZZ` because a `vi.mock` factory is hoisted and
  // cannot reference module-scope bindings. `1` used to sit here, which is truthy but has no
  // `.created` / `.place`, so every caller's `reconcileWinnerToPersisted` degraded to a no-op —
  // see persisted-winner.fixture. The `satisfies` is the guard that keeps this copy honest.
  createChallengeWinner: vi.fn().mockResolvedValue({
    id: 1,
    place: 1,
    buzzAwarded: 500, // = WINNER_PRIZE_BUZZ, declared below
    pointsAwarded: 0,
    created: true,
  } satisfies PersistedChallengeWinner),
  distributePrizes: vi.fn(),
  getChallengeById: mockGetChallengeById,
  getChallengeEntryCount: vi.fn().mockResolvedValue(0),
  getChallengeWinners: vi.fn().mockResolvedValue([]),
  getExistingWinnersForRetry: mockGetExistingWinnersForRetry,
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
  resolveEventContext: vi.fn().mockResolvedValue(undefined),
  setChallengeActive: vi.fn(),
  updateChallengeStatus: mockUpdateChallengeStatus,
}));

vi.mock('~/server/games/daily-challenge/challenge-rewards', () => ({
  distributeParticipationPrizes: vi.fn().mockResolvedValue([]),
  promoteChallengeEntries: vi.fn().mockResolvedValue(0),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  buildWinnerPayoutTransactions: vi.fn().mockReturnValue([]),
  chargeInitialPrize: vi.fn(),
  getChallengeBuzzType: mockGetChallengeBuzzType,
  refundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  reportPoolFundingShortfall: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateArticle: vi.fn(),
  generateCollectionDetails: vi.fn(),
  generateReview: vi.fn(),
  generateThemeElements: vi.fn(),
  generateWinners: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
  getTransactionByExternalId: vi.fn().mockResolvedValue(null),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/services/challenge-engagement.service', () => ({
  sendChallengeResultsNotification: mockSendChallengeResultsNotification,
}));

vi.mock('~/server/services/commentsv2.service', () => ({
  upsertComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: { bust: vi.fn() },
}));

vi.mock('~/server/services/user.service', () => ({
  amIBlockedByUser: vi.fn().mockResolvedValue(false),
  getCosmeticsForUsers: vi.fn(() => ({})),
  getProfilePicturesForUsers: vi.fn(() => ({})),
}));

vi.mock('~/server/services/challenge-eligibility.service', () => ({
  assertCanCreateUserChallenge: vi.fn(),
  assertUserAccountInGoodStanding: vi.fn(),
}));

vi.mock('~/server/integrations/moderation', () => ({
  extModeration: {},
}));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { endChallengeAndPickWinners } = await import('~/server/services/challenge.service');
const { pickWinnersForChallenge } = await import('~/server/jobs/daily-challenge-processing');
const { ChallengeSource, ChallengeStatus } = await import('~/shared/utils/prisma/enums');
const { recordChallengeCompleted, recordChallengePrizePaidBuzz, __resetChallengeMetricsForTest } =
  await import('~/server/prom/challenge.metrics');

const COMPLETED_METRIC = 'civitai_app_challenge_completed_total';
const PRIZE_PAID_METRIC = 'civitai_app_challenge_prize_paid_buzz_total';

type Series = { value: number; labels: Record<string, string> };

/**
 * Read a single series off the REAL default registry. Returns `undefined` for an absent series
 * rather than defaulting to 0, so "never emitted" can never be mistaken for "emitted zero".
 */
async function seriesFor(
  name: string,
  labels: Record<string, string>
): Promise<Series | undefined> {
  const metric = client.register.getSingleMetric(name) as unknown as {
    get: () => Promise<{ values: Series[] }>;
  };
  const data = await metric.get();
  return data.values.find((v) =>
    Object.entries(labels).every(([key, val]) => v.labels[key] === val)
  );
}

// The stamp the JOB's claim writes to metadata.completingClaimedAt once the reset frees the row.
const JOB_CLAIM_STAMP = '2026-07-29T12:20:00.000Z';

// The single winner, worth 500 green Buzz. Both runs pay this same winner: the service run pays it
// and dies, the job run re-issues the identical deterministic-id transaction. 500 Buzz moved ONCE,
// so the counter must read 500 — 1000 is the double count this file exists to catch.
const WINNER_PRIZE_BUZZ = 500;
const EXISTING_WINNERS = [
  { userId: 1, imageId: 10, place: 1, buzzAwarded: WINNER_PRIZE_BUZZ, reason: 'best' },
];

const challengeRow = {
  id: 1,
  title: 'Boundary Challenge',
  status: ChallengeStatus.Active,
  collectionId: 100,
  source: ChallengeSource.System,
  buzzType: 'green',
  prizes: [{ buzz: WINNER_PRIZE_BUZZ, points: 0 }],
  entryPrize: { buzz: 50, points: 0 },
  entryPrizeRequirement: 1,
  prizePool: 0,
  prizeDistribution: null,
  operationSpent: 0,
  operationBudget: 0,
  entryFee: 0,
  judgeId: null,
  judgingPrompt: null,
  judgingCategories: null,
  eventId: null,
  createdById: 999,
  metadata: { completingClaimedAt: JOB_CLAIM_STAMP },
};

// The shape the scheduled job is handed for the same challenge.
const jobChallenge = {
  challengeId: 1,
  type: 'daily',
  date: new Date(),
  theme: 'test',
  modelId: 1,
  modelVersionIds: [1],
  collectionId: 100,
  title: 'Boundary Challenge',
  invitation: '',
  coverUrl: '',
  prizes: [{ buzz: WINNER_PRIZE_BUZZ, points: 0 }],
  entryPrizeRequirement: 1,
  entryPrize: { buzz: 0, points: 0 },
} as never;

const JOB_CONFIG = {
  challengeType: 'world-morph',
  challengeCollectionId: 1,
  judgedTagId: 11,
  reviewMeTagId: 12,
  prizes: [],
  entryPrizeRequirement: 1,
  entryPrize: { buzz: 0, points: 0 },
  reviewAmount: { min: 6, max: 12 },
  maxScoredPerUser: 5,
  finalReviewAmount: 10,
  resourceCosmeticId: null,
  articleTagId: 1,
  defaultJudgeId: 1,
  defaultJudge: null,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  __resetChallengeMetricsForTest();
  mockDbWriteExecuteRaw.mockResolvedValue(1);
  mockDbWriteChallengeUpdate.mockResolvedValue(undefined);
  mockDbWriteChallengeFindUnique.mockResolvedValue({ prizePool: 0, prizeDistribution: null });
  mockGetChallengeById.mockResolvedValue(challengeRow);
  mockGetExistingWinnersForRetry.mockResolvedValue(EXISTING_WINNERS);
  mockCreateBuzzTransactionMany.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
  mockGetChallengeBuzzType.mockResolvedValue('green');
  mockEndChallenge.mockResolvedValue(undefined);
  mockUpdateChallengeStatus.mockResolvedValue(undefined);
  mockSendChallengeResultsNotification.mockResolvedValue(undefined);
  mockClaimChallengeForCompletion.mockResolvedValue(JOB_CLAIM_STAMP);
});

describe('mod -> job completion boundary — prize Buzz is counted exactly once', () => {
  it('a moderator run that pays winners then throws before its Completed write emits nothing', async () => {
    // The entry-participation prize block runs (user 2 earned it, user 1 is the winner) and its
    // notification throws — i.e. a failure strictly BETWEEN the winner payout and the Completed
    // write, which is the whole hazard window.
    mockDbReadQueryRaw.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }]);
    mockCreateNotification.mockRejectedValueOnce(new Error('notification service down'));

    await expect(endChallengeAndPickWinners(1)).rejects.toThrow('notification service down');

    // The winner payout DID happen...
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalled();
    // ...the Completed write did NOT (challenge is left in Completing for recovery)...
    expect(mockDbWriteChallengeUpdate).not.toHaveBeenCalled();
    // ...so nothing may have been counted yet. This is the assertion the old emit placement broke.
    expect(recordChallengePrizePaidBuzz).not.toHaveBeenCalled();
    expect(recordChallengeCompleted).not.toHaveBeenCalled();
    expect(
      await seriesFor(PRIZE_PAID_METRIC, { source: 'System', buzzType: 'green' })
    ).toBeUndefined();
  });

  it('the job retry after that failure yields exactly ONE prize-Buzz increment for one payout', async () => {
    // --- Phase 1: the moderator run pays the winner, then dies before marking Completed.
    mockDbReadQueryRaw.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }]);
    mockCreateNotification.mockRejectedValueOnce(new Error('notification service down'));
    await expect(endChallengeAndPickWinners(1)).rejects.toThrow('notification service down');

    // --- Phase 2: resetStuckCompletingChallenges flips Completing -> Active, the scheduled job
    // claims it, reuses the stored winners and re-issues the identical (already-settled) payout.
    await pickWinnersForChallenge(jobChallenge, JOB_CONFIG);

    // The payout call really was made twice across the two runs — one settlement, two attempts.
    expect(mockCreateBuzzTransactionMany.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The job's Completed write landed.
    expect(mockDbWriteChallengeUpdate).toHaveBeenCalledTimes(1);
    expect(mockDbWriteChallengeUpdate.mock.calls[0][0]).toMatchObject({
      data: { status: ChallengeStatus.Completed },
    });

    // ...and the Buzz was counted ONCE.
    expect(recordChallengePrizePaidBuzz).toHaveBeenCalledTimes(1);
    expect(recordChallengeCompleted).toHaveBeenCalledTimes(1);

    const prizeSeries = await seriesFor(PRIZE_PAID_METRIC, { source: 'System', buzzType: 'green' });
    expect(prizeSeries).toBeDefined();
    expect(prizeSeries?.value).toBe(WINNER_PRIZE_BUZZ);

    const completedSeries = await seriesFor(COMPLETED_METRIC, { source: 'System' });
    expect(completedSeries).toBeDefined();
    expect(completedSeries?.value).toBe(1);
  });

  it('a clean moderator completion still emits both counters exactly once', async () => {
    // Guards the fix from the opposite direction: moving the emits after the Completed write must
    // not have dropped them from the happy path.
    mockDbReadQueryRaw.mockResolvedValueOnce([{ userId: 1 }]);

    await expect(endChallengeAndPickWinners(1)).resolves.toMatchObject({ success: true });

    expect(mockDbWriteChallengeUpdate).toHaveBeenCalledTimes(1);
    expect(recordChallengeCompleted).toHaveBeenCalledTimes(1);
    expect(recordChallengePrizePaidBuzz).toHaveBeenCalledTimes(1);

    const prizeSeries = await seriesFor(PRIZE_PAID_METRIC, { source: 'System', buzzType: 'green' });
    expect(prizeSeries).toBeDefined();
    expect(prizeSeries?.value).toBe(WINNER_PRIZE_BUZZ);
  });

  it('a winner-notification failure no longer desyncs the two counters on the moderator path', async () => {
    // Pre-fix the completed emit sat AFTER the winner-notification loop while the prize emit had
    // already fired, so a throw there left prize_paid counted and completed NOT counted for a
    // challenge that is permanently Completed (status is already written, so the time-based
    // Completing reset can never retry it). Both emits now anchor to the same successful write.
    mockDbReadQueryRaw.mockResolvedValueOnce([{ userId: 1 }]);
    mockCreateNotification.mockRejectedValueOnce(new Error('winner notification failed'));

    await expect(endChallengeAndPickWinners(1)).rejects.toThrow('winner notification failed');

    expect(mockDbWriteChallengeUpdate).toHaveBeenCalledTimes(1);
    expect(recordChallengeCompleted).toHaveBeenCalledTimes(1);
    expect(recordChallengePrizePaidBuzz).toHaveBeenCalledTimes(1);

    const completedSeries = await seriesFor(COMPLETED_METRIC, { source: 'System' });
    expect(completedSeries).toBeDefined();
    expect(completedSeries?.value).toBe(1);
  });
});
