import { describe, it, expect, vi, beforeEach } from 'vitest';
import client from 'prom-client';

// Regression coverage for the SCHEDULED-JOB challenge completion telemetry.
//
// The bug this locks down: `challenge_completed_total` and `challenge_prize_paid_buzz_total` were
// only emitted from `endChallengeAndPickWinners` (the manual/moderator tRPC path). The daily job's
// own two completion sites in `pickWinnersForChallenge` — the zero-entries completion and the
// winners completion — emitted nothing, so both counters stayed permanently empty in production
// even while challenges completed and prizes were paid. Removing either emit must fail this file.
//
// The metrics module is spied THROUGH to the real implementation (not stubbed out), so every
// assertion below is backed by both the spy call AND the real prom-client series — a missing emit
// shows up as an ABSENT series, never as a helper's `?? 0` default.
//
// Mocking mirrors challenge-degenerate-winners.test.ts: `~/server/events` is stubbed to cut its
// heavy transitive chain, everything touching DB/LLM/buzz is mocked at the module boundary.

const {
  mockDbReadQueryRaw,
  mockDbReadChallengeFindUnique,
  mockDbWriteQueryRaw,
  mockDbWriteExecuteRaw,
  mockDbWriteChallengeUpdate,
  mockDbWriteChallengeFindUnique,
  mockGetChallengeConfig,
  mockGetJudgingConfig,
  mockEndChallenge,
  mockGetActiveChallenges,
  mockGenerateWinners,
  mockClaimChallengeForCompletion,
  mockGetExistingWinnersForRetry,
  mockResolveEventContext,
  mockUpdateChallengeStatus,
  mockRefundUserChallengeFunds,
  mockCreateNotification,
  mockCreateChallengeWinner,
  mockGetChallengeById,
  mockCreateBuzzTransactionMany,
  mockGetChallengeBuzzType,
  mockSendChallengeResultsNotification,
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
  mockGetChallengeConfig: vi.fn(),
  mockGetJudgingConfig: vi.fn(),
  mockEndChallenge: vi.fn().mockResolvedValue(undefined),
  mockGetActiveChallenges: vi.fn(),
  mockGenerateWinners: vi.fn(),
  mockClaimChallengeForCompletion: vi.fn().mockResolvedValue('2026-07-29T12:00:00.000Z'),
  mockGetExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  mockResolveEventContext: vi.fn().mockResolvedValue(undefined),
  mockUpdateChallengeStatus: vi.fn().mockResolvedValue(undefined),
  mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
  mockCreateChallengeWinner: vi.fn().mockResolvedValue(1),
  mockGetChallengeById: vi.fn().mockResolvedValue(null),
  mockCreateBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  mockGetChallengeBuzzType: vi.fn().mockResolvedValue('yellow'),
  mockSendChallengeResultsNotification: vi.fn().mockResolvedValue(undefined),
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
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(false) };
});

// Spy THROUGH to the real record helpers so the assertions can read the real registry series.
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
  createChallengeWinner: mockCreateChallengeWinner,
  getChallengeById: mockGetChallengeById,
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
  generateReview: vi.fn(),
  generateWinners: mockGenerateWinners,
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
  getTransactionByExternalId: vi.fn().mockResolvedValue(null),
}));

vi.mock('~/server/services/commentsv2.service', () => ({
  upsertComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/services/challenge-engagement.service', () => ({
  sendChallengeResultsNotification: mockSendChallengeResultsNotification,
}));

vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
  buildWinnerPayoutTransactions: vi.fn().mockReturnValue([]),
  getChallengeBuzzType: mockGetChallengeBuzzType,
  reportPoolFundingShortfall: vi.fn(),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { pickWinnersForChallenge } = await import('~/server/jobs/daily-challenge-processing');
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');
const {
  recordChallengeCompleted,
  recordChallengePrizePaidBuzz,
  __resetChallengeMetricsForTest,
} = await import('~/server/prom/challenge.metrics');

const COMPLETED_METRIC = 'civitai_app_challenge_completed_total';
const PRIZE_PAID_METRIC = 'civitai_app_challenge_prize_paid_buzz_total';

type Series = { value: number; labels: Record<string, string> };

/**
 * Read a single series off the REAL default registry. Deliberately returns `undefined` when the
 * series is absent rather than defaulting to 0 — a missing emit must be distinguishable from an
 * emit of zero, which is exactly the trap that let an earlier metrics test pass both with and
 * without the fix.
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

async function allSeries(name: string): Promise<Series[]> {
  const metric = client.register.getSingleMetric(name) as unknown as {
    get: () => Promise<{ values: Series[] }>;
  };
  return (await metric.get()).values;
}

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

// 3 prize places (500/250/100 = 850 configured) — only 2 are awarded below, so the emitted
// prize total must be 750, not the 850 sitting in the prize table.
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
  prizes: [
    { buzz: 500, points: 10 },
    { buzz: 250, points: 5 },
    { buzz: 100, points: 2 },
  ],
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 0, points: 0 },
} as never;

// The stamp `claimChallengeForCompletion` writes to metadata.completingClaimedAt for THIS run.
const CLAIM_STAMP = '2026-07-29T12:00:00.000Z';
// The stamp a SECOND run would write after resetStuckCompletingChallenges revoked our claim.
const TAKEOVER_STAMP = '2026-07-29T12:11:00.000Z';

function challengeRecordWith(
  source: string,
  rowMetadata: Record<string, unknown> = { completingClaimedAt: CLAIM_STAMP }
) {
  return {
    id: 1,
    collectionId: 100,
    source,
    entryFee: 0,
    operationSpent: 0,
    metadata: rowMetadata,
    prizes: [
      { buzz: 500, points: 10 },
      { buzz: 250, points: 5 },
      { buzz: 100, points: 2 },
    ],
  };
}

function mockChallengeJudgeRow(
  source: string | undefined,
  rowMetadata: Record<string, unknown> = { completingClaimedAt: CLAIM_STAMP }
) {
  mockDbReadQueryRaw.mockResolvedValueOnce([
    source === undefined
      ? undefined
      : {
          judgeId: null,
          judgingPrompt: null,
          eventId: null,
          source,
          judgingCategories: null,
          metadata: rowMetadata,
        },
  ]);
}

function mockJudgedEntryRows(rows: Array<{ imageId: number; userId: number; username: string }>) {
  mockDbReadQueryRaw.mockResolvedValueOnce(
    rows.map((row) => ({
      ...row,
      note: JSON.stringify({
        score: { theme: 10, aesthetic: 8, humor: 8, wittiness: 8 },
        summary: `entry by ${row.username}`,
      }),
    }))
  );
}

/**
 * Drive the fresh two-entrant LLM path to a winners completion with 2 of 3 places filled.
 * `rowStamp` is the claim stamp the challenge row carries when it is re-read at step 7 — pass
 * TAKEOVER_STAMP to simulate this run's claim being revoked and re-taken mid-flight.
 */
async function runTwoWinnerCompletion(source: string, rowStamp: string | undefined = CLAIM_STAMP) {
  const rowMetadata = rowStamp === undefined ? {} : { completingClaimedAt: rowStamp };
  mockGetChallengeById.mockResolvedValue(challengeRecordWith(source, rowMetadata));
  mockChallengeJudgeRow(source, rowMetadata);
  mockJudgedEntryRows([
    { imageId: 1, userId: 100, username: 'alice' },
    { imageId: 2, userId: 200, username: 'bob' },
  ]);
  mockDbWriteQueryRaw.mockResolvedValueOnce([]);
  mockGenerateWinners.mockResolvedValue({
    process: 'llm',
    outcome: 'llm-picked',
    model: 'test-model',
    usage: {},
    winners: [
      { creator: 'alice', creatorId: 100, reason: 'best' },
      { creator: 'bob', creatorId: 200, reason: 'second' },
    ],
  });

  await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChallengeMetricsForTest();
  mockDbWriteExecuteRaw.mockResolvedValue(1);
  // clearAllMocks clears calls but NOT implementations — restore explicitly so the
  // rejecting-write test below cannot leak into the tests that follow it.
  mockDbWriteChallengeUpdate.mockResolvedValue(undefined);
  mockGetChallengeConfig.mockResolvedValue(BASE_CONFIG);
  mockGetJudgingConfig.mockResolvedValue(JUDGING_CONFIG);
  mockEndChallenge.mockResolvedValue(undefined);
  mockClaimChallengeForCompletion.mockResolvedValue(CLAIM_STAMP);
  mockGetExistingWinnersForRetry.mockResolvedValue([]);
  mockResolveEventContext.mockResolvedValue(undefined);
  mockUpdateChallengeStatus.mockResolvedValue(undefined);
  mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 0 });
  mockDbWriteChallengeFindUnique.mockResolvedValue({ prizePool: 0, prizeDistribution: null });
  mockCreateChallengeWinner.mockResolvedValue(1);
  mockGetChallengeById.mockResolvedValue(null);
  mockGetChallengeBuzzType.mockResolvedValue('yellow');
});

describe('pickWinnersForChallenge — zero-entries completion telemetry', () => {
  it('emits challenge_completed_total exactly once with the challenge source', async () => {
    mockChallengeJudgeRow(ChallengeSource.User);
    // userBestEntries returns no rows -> getJudgedEntries short-circuits to [].
    mockDbReadQueryRaw.mockResolvedValueOnce([]);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // The completion actually happened...
    expect(mockUpdateChallengeStatus).toHaveBeenCalledWith(1, 'Completed');
    // ...and it was counted, once, with the right source.
    expect(recordChallengeCompleted).toHaveBeenCalledTimes(1);
    expect(recordChallengeCompleted).toHaveBeenCalledWith({ source: ChallengeSource.User });

    const series = await seriesFor(COMPLETED_METRIC, { source: 'User' });
    expect(series).toBeDefined();
    expect(series?.value).toBe(1);
  });

  it('does not emit a prize payout for a zero-winner completion', async () => {
    mockChallengeJudgeRow(ChallengeSource.User);
    mockDbReadQueryRaw.mockResolvedValueOnce([]);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(recordChallengePrizePaidBuzz).not.toHaveBeenCalled();
    expect(await allSeries(PRIZE_PAID_METRIC)).toHaveLength(0);
  });
});

describe('pickWinnersForChallenge — winners completion telemetry', () => {
  it('emits challenge_completed_total once for a winners completion', async () => {
    await runTwoWinnerCompletion(ChallengeSource.System);

    expect(mockCreateChallengeWinner).toHaveBeenCalledTimes(2);
    expect(recordChallengeCompleted).toHaveBeenCalledTimes(1);
    expect(recordChallengeCompleted).toHaveBeenCalledWith({ source: ChallengeSource.System });

    const series = await seriesFor(COMPLETED_METRIC, { source: 'System' });
    expect(series).toBeDefined();
    expect(series?.value).toBe(1);
  });

  it('emits the prize buzz ACTUALLY awarded to winners, not the configured prize table', async () => {
    await runTwoWinnerCompletion(ChallengeSource.System);

    // 2 of 3 places filled: 500 + 250. The prize table totals 850 — reporting that would
    // overstate payouts on every partial-winner completion.
    expect(recordChallengePrizePaidBuzz).toHaveBeenCalledTimes(1);
    expect(recordChallengePrizePaidBuzz).toHaveBeenCalledWith({
      source: ChallengeSource.System,
      buzzType: 'yellow',
      amount: 750,
    });

    const series = await seriesFor(PRIZE_PAID_METRIC, { source: 'System', buzzType: 'yellow' });
    expect(series).toBeDefined();
    expect(series?.value).toBe(750);
  });

  it('reports the buzz total from the retry path (existing winners) as recorded on ChallengeWinner', async () => {
    mockGetChallengeById.mockResolvedValue(challengeRecordWith(ChallengeSource.User));
    mockGetChallengeBuzzType.mockResolvedValue('green');
    mockGetExistingWinnersForRetry.mockResolvedValue([
      { userId: 100, imageId: 1, place: 1, buzzAwarded: 400, reason: 'best' },
      { userId: 200, imageId: 2, place: 2, buzzAwarded: 200, reason: 'second' },
    ]);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // Retry reuses stored winners; no fresh judging, no fresh ChallengeWinner rows.
    expect(mockGenerateWinners).not.toHaveBeenCalled();
    expect(recordChallengeCompleted).toHaveBeenCalledTimes(1);
    expect(recordChallengePrizePaidBuzz).toHaveBeenCalledWith({
      source: ChallengeSource.User,
      buzzType: 'green',
      amount: 600,
    });

    const series = await seriesFor(PRIZE_PAID_METRIC, { source: 'User', buzzType: 'green' });
    expect(series).toBeDefined();
    expect(series?.value).toBe(600);
  });
});

describe('pickWinnersForChallenge — emit placement is retry-safe', () => {
  it('emits nothing when the atomic completion claim is lost (challenge not Active)', async () => {
    mockClaimChallengeForCompletion.mockResolvedValue(null);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(recordChallengeCompleted).not.toHaveBeenCalled();
    expect(recordChallengePrizePaidBuzz).not.toHaveBeenCalled();
    expect(await allSeries(COMPLETED_METRIC)).toHaveLength(0);
    expect(await allSeries(PRIZE_PAID_METRIC)).toHaveLength(0);
  });

  it('emits only AFTER the Completed status write, never at the payout call', async () => {
    await runTwoWinnerCompletion(ChallengeSource.System);

    // Only one challenge.update runs for a System-source completion: the Completed write.
    expect(mockDbWriteChallengeUpdate).toHaveBeenCalledTimes(1);
    const completedWriteOrder = mockDbWriteChallengeUpdate.mock.invocationCallOrder[0];
    const payoutOrder = mockCreateBuzzTransactionMany.mock.invocationCallOrder[0];
    const completedEmitOrder = vi.mocked(recordChallengeCompleted).mock.invocationCallOrder[0];
    const prizeEmitOrder = vi.mocked(recordChallengePrizePaidBuzz).mock.invocationCallOrder[0];

    // The payout happens first, but the emits must not ride along with it: a crash between the
    // payout and the Completed write leaves the challenge to be reset Active and retried, and the
    // retry re-issues the (idempotent) payout. Counting at the payout would double-count Buzz that
    // was only ever paid once; counting after the Completed write happens once per challenge.
    expect(payoutOrder).toBeLessThan(completedWriteOrder);
    expect(completedEmitOrder).toBeGreaterThan(completedWriteOrder);
    expect(prizeEmitOrder).toBeGreaterThan(completedWriteOrder);
  });

  it('does not emit when the Completed status write throws', async () => {
    mockDbWriteChallengeUpdate.mockRejectedValue(new Error('db down'));

    await expect(runTwoWinnerCompletion(ChallengeSource.System)).rejects.toThrow('db down');

    expect(recordChallengeCompleted).not.toHaveBeenCalled();
    expect(recordChallengePrizePaidBuzz).not.toHaveBeenCalled();
  });
});

// The ENTRY guard (claim never acquired) is covered above. This block covers the case that guard
// cannot reach: the claim WAS acquired, then revoked mid-flight by resetStuckCompletingChallenges
// (purely time-based — no liveness check, no ownership token) and re-taken by a second run, while
// this run keeps executing. Both Completed writes are unconditional `UPDATE ... WHERE id = $1` with
// no status predicate, so this run's write still lands; without a claim re-check it would also emit,
// on top of the takeover run's emit. The re-checked claim stamp is what holds the counters to one
// increment per completion.
describe('pickWinnersForChallenge — claim REVOKED mid-flight (write still runs)', () => {
  it('winners path: still performs the Completed write but does NOT emit', async () => {
    await runTwoWinnerCompletion(ChallengeSource.System, TAKEOVER_STAMP);

    // The unconditional write really did execute — this is the whole point of the case.
    expect(mockDbWriteChallengeUpdate).toHaveBeenCalledTimes(1);
    expect(mockDbWriteChallengeUpdate.mock.calls[0][0]).toMatchObject({
      data: { status: 'Completed' },
    });
    // The payout ran too (it is retry-safe, so the takeover run re-issued the same one).
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalled();

    // ...and neither counter moved, so the takeover run's own emits are the only ones.
    expect(recordChallengeCompleted).not.toHaveBeenCalled();
    expect(recordChallengePrizePaidBuzz).not.toHaveBeenCalled();
    expect(await allSeries(COMPLETED_METRIC)).toHaveLength(0);
    expect(await allSeries(PRIZE_PAID_METRIC)).toHaveLength(0);
  });

  it('zero-entries path: still marks Completed but does NOT emit', async () => {
    mockChallengeJudgeRow(ChallengeSource.User, { completingClaimedAt: TAKEOVER_STAMP });
    mockDbReadQueryRaw.mockResolvedValueOnce([]);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockUpdateChallengeStatus).toHaveBeenCalledWith(1, 'Completed');
    expect(recordChallengeCompleted).not.toHaveBeenCalled();
    expect(await allSeries(COMPLETED_METRIC)).toHaveLength(0);
  });

  it('fails OPEN when the row carries no claim stamp at all (replica lag is not a takeover)', async () => {
    // A missing stamp is indistinguishable from a replica that has not caught up with our own claim
    // write, so the gate must NOT suppress here — it may only ever drop a duplicate.
    await runTwoWinnerCompletion(ChallengeSource.System, undefined);

    expect(recordChallengeCompleted).toHaveBeenCalledTimes(1);
    const series = await seriesFor(COMPLETED_METRIC, { source: 'System' });
    expect(series).toBeDefined();
    expect(series?.value).toBe(1);
  });
});

describe('pickWinnersForChallenge — labels stay enum-bound', () => {
  it('routes an unrecognized source through normSource to "unknown"', async () => {
    mockGetChallengeById.mockResolvedValue(challengeRecordWith('Sneaky<script>'));
    mockChallengeJudgeRow('Sneaky<script>');
    mockJudgedEntryRows([
      { imageId: 1, userId: 100, username: 'alice' },
      { imageId: 2, userId: 200, username: 'bob' },
    ]);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm-picked',
      model: 'test-model',
      usage: {},
      winners: [
        { creator: 'alice', creatorId: 100, reason: 'best' },
        { creator: 'bob', creatorId: 200, reason: 'second' },
      ],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    for (const name of [COMPLETED_METRIC, PRIZE_PAID_METRIC]) {
      const values = await allSeries(name);
      expect(values).toHaveLength(1);
      expect(values[0].labels.source).toBe('unknown');
    }
  });
});
