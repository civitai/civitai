import { describe, it, expect, vi, beforeEach } from 'vitest';
// Namespace type-imports (erased at compile time, so they are safe above the hoisted vi.mock calls)
// — the repo forbids inline `typeof import(...)` annotations.
import type * as FliptClient from '~/server/flipt/client';
import type * as ChallengeFunding from '~/server/games/daily-challenge/challenge-funding';

// The MODERATOR completion path — `endChallengeAndPickWinners`, reached from the tRPC router when a
// mod ends a challenge by hand. It has its own `createChallengeWinner` +
// `reconcileWinnerToPersisted` loop, separate from the scheduled job's, and until this file existed
// nothing covered it: every suite that touched it doubled `createChallengeWinner` as `1`, which is
// truthy but has no `.created` / `.place`, so the reconcile degraded to a no-op and the call could
// be deleted with the whole suite still green.
//
// Winner-prize payouts are deduped ONLY by their externalTransactionId, which embeds the PLACE
// (`challenge-winner-prize-{challengeId}-{userId}-place-{place}`). `createBuzzTransactionMany` adds
// no dedupe of its own, so these tests assert on the real transaction ids handed to the ledger and
// deliberately leave the real (pure) `buildWinnerPayoutTransactions` unmocked.
//
// Mocking mirrors challenge-judging-categories-gate.service.test.ts, which is the leanest existing
// harness that drives this function down its LLM re-pick branch.

const {
  mockDbWrite,
  mockGetJudgedEntries,
  mockGenerateWinners,
  mockGetChallengeById,
  mockCreateChallengeWinner,
  mockCreateBuzzTransactionMany,
  mockGetExistingWinnersForRetry,
  mockWithRetries,
  mockBuildWinnerPayoutTransactions,
} = vi.hoisted(() => ({
  mockDbWrite: {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    challenge: {
      update: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue({ prizePool: 0, prizeDistribution: null }),
    },
  },
  mockGetJudgedEntries: vi.fn(),
  mockGenerateWinners: vi.fn(),
  mockGetChallengeById: vi.fn(),
  mockCreateChallengeWinner: vi.fn(),
  mockCreateBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  mockGetExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  // Real `withRetries` re-invokes its closure up to 4 times on a flaky payout; doubled so a test can
  // drive that deterministically.
  mockWithRetries: vi.fn(),
  // A SPY that delegates to the real (pure) builder — the transaction ids stay genuine, but the
  // number of times the payout is BUILT becomes observable.
  mockBuildWinnerPayoutTransactions: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: vi.fn().mockResolvedValue([]), challenge: { findUnique: vi.fn() } },
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(false) };
});

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
  safeError: vi.fn((e: unknown) => e),
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: vi.fn().mockResolvedValue({
    defaultJudgeId: 1,
    defaultJudge: null,
    judgedTagId: 1,
    reviewMeTagId: 2,
    winnerCooldown: '7 day',
    finalReviewAmount: 10,
    maxScoredPerUser: 5,
    reviewAmount: { min: 6, max: 12 },
  }),
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: vi.fn().mockResolvedValue({
    judgeId: 1,
    userId: 999,
    sourceCollectionId: null,
    prompts: {},
    reviewTemplate: null,
  }),
  endChallenge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  claimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  closeChallengeCollection: vi.fn().mockResolvedValue(undefined),
  createChallengeWinner: mockCreateChallengeWinner,
  getChallengeById: mockGetChallengeById,
  getChallengeWinners: vi.fn().mockResolvedValue([]),
  getExistingWinnersForRetry: mockGetExistingWinnersForRetry,
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
  resolveEventContext: vi.fn().mockResolvedValue(undefined),
  updateChallengeStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateArticle: vi.fn(),
  generateReview: vi.fn(),
  generateThemeElements: vi.fn(),
  generateWinners: mockGenerateWinners,
}));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({
  getCoverOfModel: vi.fn(),
  getJudgedEntries: mockGetJudgedEntries,
}));

// `buildWinnerPayoutTransactions` is deliberately left REAL (it is pure) so the assertions below run
// against the genuine externalTransactionId strings — the actual money keys.
vi.mock('~/server/games/daily-challenge/challenge-funding', async (importOriginal) => {
  const actual = await importOriginal<typeof ChallengeFunding>();
  mockBuildWinnerPayoutTransactions.mockImplementation(actual.buildWinnerPayoutTransactions);
  return {
    ...actual,
    buildWinnerPayoutTransactions: mockBuildWinnerPayoutTransactions,
    chargeInitialPrize: vi.fn(),
    refundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
    reportPoolFundingShortfall: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
  getTransactionByExternalId: vi.fn().mockResolvedValue(null),
  refundMultiAccountTransaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/challenge-engagement.service', () => ({
  sendChallengeResultsNotification: vi.fn().mockResolvedValue(undefined),
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

vi.mock('~/server/integrations/moderation', () => ({ extModeration: {} }));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/utils/errorHandling', () => ({
  withRetries: mockWithRetries,
}));

vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { endChallengeAndPickWinners } = await import('~/server/services/challenge.service');
const { ChallengeSource, ChallengeStatus } = await import('~/shared/utils/prisma/enums');
const { __resetChallengeMetricsForTest } = await import('~/server/prom/challenge.metrics');
const client = (await import('prom-client')).default;

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

const CHALLENGE_ID = 42;

const challengeRow = {
  id: CHALLENGE_ID,
  title: 'Mod Ended Challenge',
  status: ChallengeStatus.Active,
  collectionId: 100,
  source: ChallengeSource.System,
  buzzType: 'yellow',
  theme: 'test',
  prizes: [
    { buzz: 500, points: 10 },
    { buzz: 250, points: 5 },
    { buzz: 100, points: 2 },
  ],
  // Left null so the entry-participation prize block is skipped — it is a different payout with its
  // own transaction ids and would only add noise to the winner-prize assertions here.
  entryPrize: null,
  entryPrizeRequirement: 10,
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
  modelVersionIds: [],
  metadata: null,
};

const JUDGED_ENTRIES = [
  { imageId: 1, userId: 100, username: 'alice', summary: 'a', score: 10 },
  { imageId: 2, userId: 200, username: 'bob', summary: 'b', score: 9 },
  { imageId: 3, userId: 300, username: 'carol', summary: 'c', score: 8 },
];

function llmWinners(winners: Array<{ creatorId: number; creator: string }>) {
  mockGenerateWinners.mockResolvedValue({
    process: 'llm',
    outcome: 'llm-picked',
    model: 'test-model',
    usage: {},
    winners: winners.map((w) => ({ ...w, reason: `because ${w.creator}` })),
  });
}

/** See challenge-winner-payout-dedupe.test.ts — a double that enforces (challengeId, userId). */
function stubUniqueWinnerTable() {
  const stored = new Map<number, { id: number; place: number; buzzAwarded: number }>();
  mockCreateChallengeWinner.mockImplementation(
    async ({
      userId,
      place,
      buzzAwarded,
    }: {
      userId: number;
      place: number;
      buzzAwarded: number;
    }) => {
      const existing = stored.get(userId);
      if (existing) return { ...existing, pointsAwarded: 0, created: false };
      const row = { id: stored.size + 1, place, buzzAwarded };
      stored.set(userId, row);
      return { ...row, pointsAwarded: 0, created: true };
    }
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
  __resetChallengeMetricsForTest();
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  mockDbWrite.$executeRaw.mockResolvedValue(1);
  mockDbWrite.challenge.update.mockResolvedValue(undefined);
  mockDbWrite.challenge.findUnique.mockResolvedValue({ prizePool: 0, prizeDistribution: null });
  mockGetChallengeById.mockResolvedValue(challengeRow);
  mockGetExistingWinnersForRetry.mockResolvedValue([]);
  mockGetJudgedEntries.mockResolvedValue(JUDGED_ENTRIES);
  mockCreateBuzzTransactionMany.mockResolvedValue(undefined);
  // Default: the happy path, one invocation — same as real `withRetries` when nothing throws.
  mockWithRetries.mockImplementation((fn: (remaining: number) => unknown) => fn(3));
  stubUniqueWinnerTable();
});

describe('endChallengeAndPickWinners — payout keys on the PERSISTED placement', () => {
  it('a permuted re-pick over existing records pays the recorded places, not the new ones', async () => {
    // Users 100 and 200 are already recorded — and already PAID — at places 1 and 2. This run's
    // `getExistingWinnersForRetry` came back empty (rows written by a concurrent run after this
    // run's read), so it goes down the fresh LLM re-pick path and picks the same two users with
    // their places SWAPPED.
    llmWinners([
      { creatorId: 200, creator: 'bob' },
      { creatorId: 100, creator: 'alice' },
    ]);
    mockCreateChallengeWinner.mockImplementation(async ({ userId }: { userId: number }) =>
      userId === 200
        ? { id: 2, place: 2, buzzAwarded: 250, pointsAwarded: 5, created: false }
        : { id: 1, place: 1, buzzAwarded: 500, pointsAwarded: 10, created: false }
    );

    await endChallengeAndPickWinners(CHALLENGE_ID);

    // `...-200-place-1` / `...-100-place-2` would be fresh, never-seen ids the ledger's idempotency
    // index cannot dedupe — a second prize for two users who were already paid.
    expect(paidExternalIds().sort()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-2`,
    ]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-1`]: 500,
      [`challenge-winner-prize-${CHALLENGE_ID}-200-place-2`]: 250,
    });
  });

  it('a single winner re-picked at a different place pays the recorded place only', async () => {
    llmWinners([{ creatorId: 100, creator: 'alice' }]); // picked place 1
    // ...but alice is already recorded (and paid) at place 3.
    mockCreateChallengeWinner.mockResolvedValue({
      id: 7,
      place: 3,
      buzzAwarded: 100,
      pointsAwarded: 2,
      created: false,
    });

    await endChallengeAndPickWinners(CHALLENGE_ID);

    expect(paidExternalIds()).toEqual([`challenge-winner-prize-${CHALLENGE_ID}-100-place-3`]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-3`]: 100,
    });
  });

  it('fresh winners (no conflict) pay the freshly-picked places — happy path unchanged', async () => {
    llmWinners([
      { creatorId: 200, creator: 'bob' },
      { creatorId: 100, creator: 'alice' },
    ]);

    await endChallengeAndPickWinners(CHALLENGE_ID);

    expect(paidExternalIds()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-2`,
    ]);
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-200-place-1`]: 500,
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-2`]: 250,
    });
  });
});

describe('endChallengeAndPickWinners — one creator named twice is paid once', () => {
  it('pays the duplicated creator exactly once, at their better place, with no repeated id', async () => {
    // `generateWinners` returns raw LLM JSON; "Select exactly 3 different winners" is prompt text
    // with no code-level enforcement, and the mapping loop resolves each winner with a `find()` by
    // creatorId — so one creator in two slots yields two entries holding two places.
    llmWinners([
      { creatorId: 100, creator: 'alice' },
      { creatorId: 100, creator: 'alice' },
      { creatorId: 200, creator: 'bob' },
    ]);

    await endChallengeAndPickWinners(CHALLENGE_ID);

    const ids = paidExternalIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-3`,
    ]);
    // alice keeps place 1 (500), not the dropped place 2 (250).
    expect(paidAmountsById()).toEqual({
      [`challenge-winner-prize-${CHALLENGE_ID}-100-place-1`]: 500,
      [`challenge-winner-prize-${CHALLENGE_ID}-200-place-3`]: 100,
    });
    // Dropped BEFORE the create loop, so the duplicate never conflicts against the row its own twin
    // just inserted — a conflict that would otherwise fire the place-divergence signal for
    // something that is not a re-pick at all.
    expect(mockCreateChallengeWinner).toHaveBeenCalledTimes(2);
    // The anomaly must be visible on the mod path too. Without this the emit could be deleted with
    // the suite still green — and this is the human-triggered path, so its signal is the one most
    // likely to be wanted and, until now, the only one unprotected.
    expect(await counterValue(DUPLICATE_PICK_METRIC, { source: ChallengeSource.System })).toBe(1);
  });

  // `origin` was asserted nowhere on either path, so its two values were interchangeable and the
  // label could be flipped with the whole suite still green. Mislabelling a caller emit as
  // `chokepoint` produces exactly the operator misreading the label was introduced to prevent: the
  // choke point's own drop means "a caller reached the money path with duplicates and did NOT report
  // it" — real prize money silently unpaid — so an operator would open an incident for a payout
  // failure that never happened, on the human-triggered path where someone is already watching.
  it('tags the drop as origin=caller — this path reported it, the choke point did not catch it', async () => {
    llmWinners([
      { creatorId: 100, creator: 'alice' },
      { creatorId: 100, creator: 'alice' },
      { creatorId: 200, creator: 'bob' },
    ]);

    await endChallengeAndPickWinners(CHALLENGE_ID);

    expect(
      await counterValue(DUPLICATE_PICK_METRIC, {
        source: ChallengeSource.System,
        origin: 'caller',
      })
    ).toBe(1);
    // The duplicate was dropped before the builder saw it, so the choke point's guard is a genuine
    // no-op here and must leave no series behind.
    expect(await counterValue(DUPLICATE_PICK_METRIC, { origin: 'chokepoint' })).toBeUndefined();
  });

  it('leaves a clean pick alone — the guard does not over-trigger', async () => {
    llmWinners([
      { creatorId: 100, creator: 'alice' },
      { creatorId: 200, creator: 'bob' },
      { creatorId: 300, creator: 'carol' },
    ]);

    await endChallengeAndPickWinners(CHALLENGE_ID);

    expect(paidExternalIds()).toEqual([
      `challenge-winner-prize-${CHALLENGE_ID}-100-place-1`,
      `challenge-winner-prize-${CHALLENGE_ID}-200-place-2`,
      `challenge-winner-prize-${CHALLENGE_ID}-300-place-3`,
    ]);
    expect(mockCreateChallengeWinner).toHaveBeenCalledTimes(3);
  });
});

// Parity with the cron path: the builder is called OUTSIDE the `withRetries` closure. Its output is
// deterministic so a rebuild would not move different money — but it increments the duplicate-pick
// counter on its drop branch, and `withRetries` re-invokes up to 4 times, so inside the closure a
// flaky payout would record up to 4x the placements actually dropped.
describe('endChallengeAndPickWinners — the payout is built ONCE, outside the retry closure', () => {
  const cleanPick = () =>
    llmWinners([
      { creatorId: 100, creator: 'alice' },
      { creatorId: 200, creator: 'bob' },
    ]);

  it('a payout that retries three times still builds the transactions exactly once', async () => {
    cleanPick();
    mockWithRetries.mockImplementation(async (fn: (remaining: number) => Promise<unknown>) => {
      await fn(3);
      await fn(2);
      await fn(1);
    });

    await endChallengeAndPickWinners(CHALLENGE_ID);

    // The retry must genuinely have happened — otherwise this passes on a build that never retries.
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledTimes(3);
    expect(mockBuildWinnerPayoutTransactions).toHaveBeenCalledTimes(1);
  });

  it('every retry submits the SAME transaction array instance, not a rebuilt one', async () => {
    cleanPick();
    mockWithRetries.mockImplementation(async (fn: (remaining: number) => Promise<unknown>) => {
      await fn(3);
      await fn(2);
    });

    await endChallengeAndPickWinners(CHALLENGE_ID);

    const [first] = mockCreateBuzzTransactionMany.mock.calls[0];
    const [second] = mockCreateBuzzTransactionMany.mock.calls[1];
    // Identity, not deep equality: a rebuild yields an equal-but-distinct array, so `toEqual` would
    // pass on the very mutation this pins.
    expect(second).toBe(first);
  });

  it('does not rebuild on the happy path either — one build, one submit', async () => {
    cleanPick();

    await endChallengeAndPickWinners(CHALLENGE_ID);

    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(mockBuildWinnerPayoutTransactions).toHaveBeenCalledTimes(1);
  });
});
