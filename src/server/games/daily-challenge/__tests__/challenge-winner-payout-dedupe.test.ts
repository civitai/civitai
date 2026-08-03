import { describe, it, expect, vi, beforeEach } from 'vitest';
import client from 'prom-client';
// Namespace type-imports (erased at compile time, so they are safe above the hoisted vi.mock calls)
// — the repo forbids inline `typeof import(...)` annotations.
import type * as FliptClient from '~/server/flipt/client';
import type * as ChallengeFunding from '~/server/games/daily-challenge/challenge-funding';
import type * as ErrorHandling from '~/utils/errorHandling';

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
  mockWithRetries,
  mockBuildWinnerPayoutTransactions,
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
  // Real `withRetries` re-invokes its closure up to 4 times on a flaky payout. Doubled so a test can
  // drive that deterministically instead of making the buzz mock throw and waiting on real retries.
  mockWithRetries: vi.fn(),
  // A SPY that delegates to the real (pure) builder — assertions still run against genuine
  // externalTransactionId strings, but the number of times the payout is BUILT becomes observable.
  mockBuildWinnerPayoutTransactions: vi.fn(),
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
  const actual = await importOriginal<typeof FliptClient>();
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
  const actual = await importOriginal<typeof ChallengeFunding>();
  mockBuildWinnerPayoutTransactions.mockImplementation(actual.buildWinnerPayoutTransactions);
  return {
    ...actual,
    buildWinnerPayoutTransactions: mockBuildWinnerPayoutTransactions,
    refundUserChallengeFunds: mockRefundUserChallengeFunds,
    getChallengeBuzzType: vi.fn().mockResolvedValue('yellow'),
    reportPoolFundingShortfall: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('~/utils/errorHandling', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorHandling>();
  return { ...actual, withRetries: mockWithRetries };
});

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { pickWinnersForChallenge } = await import('~/server/jobs/daily-challenge-processing');
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');
const { __resetChallengeMetricsForTest } = await import('~/server/prom/challenge.metrics');

const DUPLICATE_PICK_METRIC = 'civitai_app_challenge_winner_duplicate_pick_total';

/**
 * Read one series off the REAL prom registry. Returns `undefined` for an absent series rather than
 * defaulting to 0, so "never emitted" can never be mistaken for "emitted zero".
 */
async function counterValue(
  name: string,
  labels: Record<string, string>
): Promise<number | undefined> {
  const metric = client.register.getSingleMetric(name) as unknown as {
    get: () => Promise<{ values: Array<{ value: number; labels: Record<string, string> }> }>;
  } | null;
  if (!metric) return undefined;
  const data = await metric.get();
  return data.values.find((v) =>
    Object.entries(labels).every(([key, val]) => v.labels[key] === val)
  )?.value;
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

/**
 * A double that enforces the real (challengeId, userId) unique constraint.
 *
 * The FIRST create for a user inserts and comes back `created: true`; every later create for that
 * same user conflicts and comes back as the STORED row with `created: false` — which is exactly
 * what the production helper does when it catches P2002 and re-reads the row. Without this, a
 * duplicate creator looks like two clean inserts and the whole failure mode disappears from the
 * test.
 */
function stubUniqueWinnerTable() {
  const stored = new Map<number, { id: number; place: number; buzzAwarded: number }>();
  mockCreateChallengeWinner.mockImplementation(
    async ({
      userId,
      place,
      buzzAwarded,
      pointsAwarded,
    }: {
      userId: number;
      place: number;
      buzzAwarded: number;
      pointsAwarded?: number;
    }) => {
      const existing = stored.get(userId);
      if (existing) return { ...existing, pointsAwarded: 0, created: false };
      const row = { id: stored.size + 1, place, buzzAwarded };
      stored.set(userId, row);
      return { ...row, pointsAwarded: pointsAwarded ?? 0, created: true };
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChallengeMetricsForTest();
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
  // Default: the happy path, one invocation — same as real `withRetries` when nothing throws.
  mockWithRetries.mockImplementation((fn: (remaining: number) => unknown) => fn(3));
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

  // The SOLE-ENTRANT branch — a completely separate `createChallengeWinner` +
  // `reconcileWinnerToPersisted` call site from the LLM loop above, reached when a challenge has
  // fewer than 2 distinct entrants and place 1 is awarded deterministically without the LLM.
  // Nothing covered it: with the stale `mockResolvedValue(1)` doubles in place, its reconcile could
  // be deleted outright and the whole suite stayed green.
  it('sole-entrant award pays the RECORDED place, not the deterministic place 1', async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
    // One distinct entrant -> the deterministic branch, no `generateWinners` call.
    mockJudgedEntryRows([{ imageId: 1, userId: 100, username: 'alice' }]);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]); // winner-cooldown query: nobody excluded

    // ...but alice is already recorded — and already PAID — at place 2 for this challenge, from an
    // earlier run of the same completion. The branch always picks place 1 with prizes[0].buzz, so
    // paying what it picked would settle a brand-new `-place-1` id on top of the `-place-2` id the
    // ledger has already honoured: a second prize.
    mockCreateChallengeWinner.mockResolvedValue({
      id: 7,
      place: 2,
      buzzAwarded: 250,
      pointsAwarded: 5,
      created: false,
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockGenerateWinners).not.toHaveBeenCalled();
    expect(paidExternalIds()).toEqual([`challenge-winner-prize-${CHALLENGE_ID}-100-place-2`]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-2`]: 250,
    });
  });

  it('sole-entrant fresh award still pays place 1 — the deterministic branch is not broken', async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
    mockJudgedEntryRows([{ imageId: 1, userId: 100, username: 'alice' }]);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    stubUniqueWinnerTable();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(paidExternalIds()).toEqual([`challenge-winner-prize-${CHALLENGE_ID}-100-place-1`]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-1`]: 500,
    });
  });
});

describe('one creator named twice in a single pick is paid once (duplicate-pick guard)', () => {
  // `generateWinners` returns raw LLM JSON. "Select exactly 3 different winners" is prompt text with
  // no code-level enforcement, and the mapping loop resolves each winner with a `find()` by
  // creatorId — so the same creator named in two slots produces two entries holding two places.
  //
  // Both outcomes of that are money bugs. Before the reconcile existed, the two entries paid under
  // two DIFFERENT ids: a straight double mint. With the reconcile, the second entry is folded onto
  // the stored row and the two collapse onto the SAME id inside one batch, which is then handed to
  // an external Buzz service whose within-batch behaviour cannot be verified from this repo.
  it('pays the duplicated creator exactly once, at their better place, with no repeated id', async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
    mockJudgedEntryRows([
      { imageId: 1, userId: 100, username: 'alice' },
      { imageId: 2, userId: 200, username: 'bob' },
      { imageId: 3, userId: 300, username: 'carol' },
    ]);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);

    // The LLM names alice in BOTH the 1st- and 2nd-place slots.
    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm-picked',
      model: 'test-model',
      usage: {},
      winners: [
        { creator: 'alice', creatorId: 100, reason: 'best' },
        { creator: 'alice', creatorId: 100, reason: 'also best' },
        { creator: 'bob', creatorId: 200, reason: 'third' },
      ],
    });
    stubUniqueWinnerTable();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    const ids = paidExternalIds();
    // No id may appear twice in one batch — the property the external Buzz service is not trusted
    // to enforce for us.
    expect(new Set(ids).size).toBe(ids.length);
    // alice keeps place 1 (the better place, 500 Buzz), NOT the dropped place 2 at 250.
    expect(ids.sort()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-3`,
    ]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-1`]: 500,
      [`challenge-winner-prize-${CHALLENGE_ID}-200-place-3`]: 100,
    });

    // Dropped BEFORE the create loop, so the duplicate never conflicts against the row its own twin
    // just inserted — that conflict would otherwise fire the place-divergence warning + counter for
    // something that is not a re-pick at all.
    expect(mockCreateChallengeWinner).toHaveBeenCalledTimes(2);
  });

  it('records the dropped placement on challenge_winner_duplicate_pick_total', async () => {
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
        { creator: 'alice', creatorId: 100, reason: 'best' },
        { creator: 'alice', creatorId: 100, reason: 'again' },
      ],
    });
    stubUniqueWinnerTable();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // An LLM handing back the same creator twice is a real judging anomaly, not something to
    // swallow silently just because the payout is now safe.
    expect(await counterValue(DUPLICATE_PICK_METRIC, { source: 'System' })).toBe(1);
  });

  // `origin` was asserted nowhere, so the two values were interchangeable and the label could be
  // flipped with every test still green. It is the sharpest label on this counter to get wrong:
  // `chokepoint` means "a caller reached the money path with duplicates and did NOT report it", i.e.
  // real prize money silently not paid, and an operator seeing it on a drop the caller DID report
  // would go hunting a payout failure that never happened.
  it('tags the drop as origin=caller — this path reported it, the choke point did not catch it', async () => {
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
        { creator: 'alice', creatorId: 100, reason: 'best' },
        { creator: 'alice', creatorId: 100, reason: 'again' },
      ],
    });
    stubUniqueWinnerTable();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(await counterValue(DUPLICATE_PICK_METRIC, { source: 'System', origin: 'caller' })).toBe(
      1
    );
    // And the choke-point series must not exist: the caller dropped the duplicate before the
    // builder ever saw it, so the builder's own guard is a genuine no-op here.
    expect(await counterValue(DUPLICATE_PICK_METRIC, { origin: 'chokepoint' })).toBeUndefined();
  });

  // The judge row is typed `| undefined` (the SELECT is `LIMIT 1` against a replica), and the emit
  // defaults its source the same way the judging call upstream does. Nothing pinned that default, so
  // it could be dropped and the `unknown` bucket would quietly absorb the emit — and `unknown` is
  // reserved for "the source could not be read", which is a different operator question from "a
  // System challenge dropped a placement".
  it('defaults the source to System when the judge row could not be read', async () => {
    // No judge row at all — the destructure yields `undefined`, which is exactly what a replica that
    // has not seen the challenge row (or a row deleted mid-run) produces.
    mockDbReadQueryRaw.mockResolvedValueOnce([]);
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
        { creator: 'alice', creatorId: 100, reason: 'again' },
      ],
    });
    stubUniqueWinnerTable();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(await counterValue(DUPLICATE_PICK_METRIC, { source: 'System', origin: 'caller' })).toBe(
      1
    );
    expect(await counterValue(DUPLICATE_PICK_METRIC, { source: 'unknown' })).toBeUndefined();
  });

  it('leaves a clean pick alone — the guard does not over-trigger', async () => {
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
        { creator: 'alice', creatorId: 100, reason: 'best' },
        { creator: 'bob', creatorId: 200, reason: 'second' },
      ],
    });
    stubUniqueWinnerTable();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(paidExternalIds()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-2`,
    ]);
    expect(mockCreateChallengeWinner).toHaveBeenCalledTimes(2);
    // Absent series, not zero — the counter must never have been touched.
    expect(await counterValue(DUPLICATE_PICK_METRIC, { source: 'System' })).toBeUndefined();
  });
});

// `buildWinnerPayoutTransactions` is called OUTSIDE the `withRetries` closure. The output is
// deterministic so rebuilding it would not move different money — but the builder increments the
// duplicate-pick counter on its drop branch, and `withRetries` re-invokes up to 4 times. Inside the
// closure, a flaky payout would record up to 4x the placements actually dropped, on exactly the run
// where the number matters most. Nothing pinned the placement of that one line.
describe('the winner payout is built ONCE, outside the retry closure', () => {
  const wireCleanTwoWinnerPick = () => {
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
        { creator: 'alice', creatorId: 100, reason: 'best' },
        { creator: 'bob', creatorId: 200, reason: 'second' },
      ],
    });
    stubUniqueWinnerTable();
  };

  it('a payout that retries three times still builds the transactions exactly once', async () => {
    wireCleanTwoWinnerPick();
    // What real `withRetries` does to its closure when the buzz call keeps failing.
    mockWithRetries.mockImplementation(async (fn: (remaining: number) => Promise<unknown>) => {
      await fn(3);
      await fn(2);
      await fn(1);
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // The retry itself must still happen — otherwise this test would pass on a build that never
    // retries at all, which is a different bug.
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledTimes(3);
    expect(mockBuildWinnerPayoutTransactions).toHaveBeenCalledTimes(1);
  });

  it('every retry submits the SAME transaction array instance, not a rebuilt one', async () => {
    wireCleanTwoWinnerPick();
    mockWithRetries.mockImplementation(async (fn: (remaining: number) => Promise<unknown>) => {
      await fn(3);
      await fn(2);
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    const [first] = mockCreateBuzzTransactionMany.mock.calls[0];
    const [second] = mockCreateBuzzTransactionMany.mock.calls[1];
    // Identity, not deep equality: a rebuild produces an equal-but-distinct array, so `toEqual`
    // would pass on the very mutation this pins.
    expect(second).toBe(first);
  });

  it('does not rebuild on the happy path either — one build, one submit', async () => {
    wireCleanTwoWinnerPick();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(mockBuildWinnerPayoutTransactions).toHaveBeenCalledTimes(1);
  });
});
