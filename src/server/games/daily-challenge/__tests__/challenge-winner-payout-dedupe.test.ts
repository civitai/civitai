import { describe, it, expect, vi, beforeEach } from 'vitest';

// Winner-prize payouts are deduped ONLY by their externalTransactionId, which embeds the winner's
// PLACE (`challenge-winner-prize-{challengeId}-{userId}-place-{place}`) — `createBuzzTransactionMany`
// adds no dedupe of its own, and nothing downstream checks whether a challenge already paid. So if a
// completion re-picks winners over an existing `ChallengeWinner` record and lands the same user on a
// DIFFERENT place, the payout goes out under a brand-new key and mints a second prize.
//
// That re-pick is not exotic. `ChallengeWinner` is uniquely keyed on (challengeId, userId), NOT on
// (challengeId, place), so the re-pick's insert conflicts and the stored row keeps its ORIGINAL
// place — while the in-memory entry that actually gets paid carries the NEW place. Record and
// payment diverge. And because the winner cooldown only excludes winners of COMPLETED challenges, a
// challenge's own in-flight winners stay eligible, which is what makes the re-pick a PERMUTATION of
// the same users rather than a fresh set.
//
// These tests assert on the real externalTransactionId strings handed to `createBuzzTransactionMany`
// — the actual money keys — so the real `buildWinnerPayoutTransactions` is left unmocked.
//
// Mocking otherwise mirrors challenge-winner-mapping.test.ts.

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
  mockGenerateWinners,
  mockClaimChallengeForCompletion,
  mockGetExistingWinnersForRetry,
  mockResolveEventContext,
  mockUpdateChallengeStatus,
  mockRefundUserChallengeFunds,
  mockCreateChallengeWinner,
  mockGetChallengeById,
  mockCreateBuzzTransactionMany,
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
  mockGenerateWinners: vi.fn(),
  mockClaimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  mockGetExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  mockResolveEventContext: vi.fn().mockResolvedValue(undefined),
  mockUpdateChallengeStatus: vi.fn().mockResolvedValue(undefined),
  mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  mockCreateChallengeWinner: vi.fn(),
  mockGetChallengeById: vi.fn().mockResolvedValue(null),
  mockCreateBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
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

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
  safeError: vi.fn((e: unknown) => e),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(false) };
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
  createBuzzTransaction: vi.fn().mockResolvedValue(undefined),
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
  getTransactionByExternalId: vi.fn().mockResolvedValue(null),
  refundMultiAccountTransaction: vi.fn().mockResolvedValue(undefined),
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

// NOTE: `buildWinnerPayoutTransactions` is deliberately left REAL (it is a pure function) so the
// assertions below run against the genuine externalTransactionId strings.
vi.mock('~/server/games/daily-challenge/challenge-funding', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('~/server/games/daily-challenge/challenge-funding')
  >();
  return {
    ...actual,
    refundUserChallengeFunds: mockRefundUserChallengeFunds,
    getChallengeBuzzType: vi.fn().mockResolvedValue('yellow'),
    reportPoolFundingShortfall: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { pickWinnersForChallenge } = await import('~/server/jobs/daily-challenge-processing');
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

const JUDGING_CONFIG = {
  judgeId: 1,
  userId: 999,
  sourceCollectionId: null,
  prompts: {},
  reviewTemplate: null,
} as never;

const CHALLENGE_ID = 69;

const currentChallenge = {
  challengeId: CHALLENGE_ID,
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

function mockChallengeJudgeRow(source: string) {
  mockDbReadQueryRaw.mockResolvedValueOnce([
    { judgeId: null, judgingPrompt: null, eventId: null, source, judgingCategories: null },
  ]);
}

function mockJudgedEntryRows(rows: Array<{ imageId: number; userId: number; username: string }>) {
  mockDbReadQueryRaw.mockResolvedValueOnce(
    rows.map((row) => ({
      imageId: row.imageId,
      userId: row.userId,
      username: row.username,
      note: JSON.stringify({
        score: { theme: 10, aesthetic: 8, humor: 8, wittiness: 8 },
        summary: `entry by ${row.username}`,
      }),
    }))
  );
}

/** The externalTransactionIds actually submitted to the buzz ledger, in submission order. */
function paidExternalIds(): string[] {
  expect(mockCreateBuzzTransactionMany).toHaveBeenCalledTimes(1);
  const [transactions] = mockCreateBuzzTransactionMany.mock.calls[0];
  return (transactions as Array<{ externalTransactionId: string }>).map(
    (t) => t.externalTransactionId
  );
}

/** externalTransactionId -> amount, so a reconciled place can be checked to pay its recorded prize. */
function paidAmountsById(): Record<string, number> {
  const [transactions] = mockCreateBuzzTransactionMany.mock.calls[0];
  return Object.fromEntries(
    (transactions as Array<{ externalTransactionId: string; amount: number }>).map((t) => [
      t.externalTransactionId,
      t.amount,
    ])
  );
}

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
  mockGetChallengeById.mockResolvedValue(null);
  mockCreateBuzzTransactionMany.mockResolvedValue(undefined);
});

describe('winner payout keys on the PERSISTED placement (duplicate-payout guard)', () => {
  it('permuted re-pick over an existing record pays the recorded places — the original transaction ids, no new money', async () => {
    // Reproduces the production signature on challenge 69: users 100 and 200 were already recorded
    // and PAID as place 1 / place 2 respectively. A second completion run re-picks the very same two
    // users with their places SWAPPED.
    //
    // The retry short-circuit does not save us here: this run's `getExistingWinnersForRetry` came
    // back empty (the rows were written by a concurrent run after this run's read), so the run goes
    // down the fresh LLM re-pick path.
    mockChallengeJudgeRow(ChallengeSource.System);
    mockJudgedEntryRows([
      { imageId: 1, userId: 100, username: 'alice' },
      { imageId: 2, userId: 200, username: 'bob' },
    ]);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]); // winner-cooldown query: nobody excluded

    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm-picked',
      model: 'test-model',
      usage: {},
      winners: [
        { creator: 'bob', creatorId: 200, reason: 'best' }, // recorded at place 2
        { creator: 'alice', creatorId: 100, reason: 'second' }, // recorded at place 1
      ],
    });

    // Both inserts conflict on (challengeId, userId); the stored rows keep their ORIGINAL places.
    mockCreateChallengeWinner.mockImplementation(async ({ userId }: { userId: number }) =>
      userId === 200
        ? { id: 2, place: 2, buzzAwarded: 250, pointsAwarded: 5, created: false }
        : { id: 1, place: 1, buzzAwarded: 500, pointsAwarded: 10, created: false }
    );

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // The payout must key to the RECORDED places. `...-200-place-1` / `...-100-place-2` would be
    // fresh, never-seen ids that the ledger's idempotency index cannot dedupe — a second prize for
    // two users who were already paid.
    expect(paidExternalIds().sort()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-2`,
    ]);

    // And each pays the amount recorded against that place, so payment matches the record exactly.
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-1`]: 500,
      [`challenge-winner-prize-${CHALLENGE_ID}-200-place-2`]: 250,
    });
  });

  it('a single winner re-picked at a different place pays the recorded place only', async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
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
      winners: [{ creator: 'alice', creatorId: 100, reason: 'best' }], // picked place 1
    });

    // ...but alice is already recorded (and paid) at place 3.
    mockCreateChallengeWinner.mockResolvedValue({
      id: 7,
      place: 3,
      buzzAwarded: 100,
      pointsAwarded: 2,
      created: false,
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(paidExternalIds()).toEqual([`challenge-winner-prize-${CHALLENGE_ID}-100-place-3`]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-3`]: 100,
    });
  });

  it('fresh winners (no conflict) pay the freshly-picked places — happy path unchanged', async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
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
        { creator: 'bob', creatorId: 200, reason: 'best' },
        { creator: 'alice', creatorId: 100, reason: 'second' },
      ],
    });

    // Rows inserted for the first time — nothing to reconcile against.
    mockCreateChallengeWinner.mockImplementation(
      async ({
        userId,
        place,
        buzzAwarded,
      }: {
        userId: number;
        place: number;
        buzzAwarded: number;
      }) => ({
        id: userId,
        place,
        buzzAwarded,
        pointsAwarded: 0,
        created: true,
      })
    );

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(paidExternalIds()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-2`,
    ]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-200-place-1`]: 500,
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-2`]: 250,
    });
  });

  it('retry short-circuit still reuses the stored winners and re-issues the same transaction ids', async () => {
    // The `getExistingWinnersForRetry` branch (now reading the primary). Behaviour must be
    // unchanged: no LLM re-pick, no new ChallengeWinner writes, payout replays the stored
    // placements so the ledger conflicts them away.
    mockGetExistingWinnersForRetry.mockResolvedValue([
      { userId: 100, imageId: 1, place: 1, buzzAwarded: 500, pointsAwarded: 10, reason: 'r1' },
      { userId: 200, imageId: 2, place: 2, buzzAwarded: 250, pointsAwarded: 5, reason: 'r2' },
    ]);

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockGenerateWinners).not.toHaveBeenCalled();
    expect(mockCreateChallengeWinner).not.toHaveBeenCalled();
    expect(paidExternalIds()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-2`,
    ]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-1`]: 500,
      [`challenge-winner-prize-${CHALLENGE_ID}-200-place-2`]: 250,
    });
  });
});
