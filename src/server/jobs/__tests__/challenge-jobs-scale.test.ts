import { describe, it, expect, vi, beforeEach } from 'vitest';

// Scale/regression guard for reviewEntries(): with CHALLENGE_JOB_BATCH_SIZE active challenges
// pulled per tick, the review loop must process every one of them (no silent drop) and must
// isolate a single challenge's failure from the rest of the batch. Per-challenge processing
// (reviewEntriesForChallenge) is swapped out via the `challengeReviewInternals` seam so this
// test exercises the real loop/scheduling code (limitConcurrency + error isolation) without
// re-mocking reviewEntriesForChallenge's own DB/LLM call chain — that's already covered by
// daily-challenge-processing.judging-categories.test.ts.
//
// The rest of daily-challenge-processing.ts's heavy import graph (db client, events,
// challenge-helpers, generative-content, buzz/notification/reaction services, challenge-funding)
// is stubbed purely so the module can load in-test; none of it is exercised because
// reviewEntriesForChallenge itself never runs for real here.

const {
  mockIsFlipt,
  mockGetActiveChallenges,
  mockLogToAxiom,
  mockGetEndedActiveChallenges,
  mockGetChallengesToReconcile,
  mockPickWinnersForChallenge,
  mockReconcileCompletedChallenge,
  mockResetStuckCompletingChallenges,
} = vi.hoisted(() => ({
  mockIsFlipt: vi.fn().mockResolvedValue(true),
  mockGetActiveChallenges: vi.fn(),
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  mockGetEndedActiveChallenges: vi.fn().mockResolvedValue([]),
  mockGetChallengesToReconcile: vi.fn().mockResolvedValue([]),
  mockPickWinnersForChallenge: vi.fn().mockResolvedValue(undefined),
  mockReconcileCompletedChallenge: vi
    .fn()
    .mockResolvedValue({ promoted: 0, paid: 0, buzzGranted: 0 }),
  mockResetStuckCompletingChallenges: vi.fn().mockResolvedValue(0),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: vi.fn(), challenge: { findUnique: vi.fn() } },
  dbWrite: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    challenge: { update: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn() },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: mockIsFlipt };
});

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async () => {
  const real = await import('~/server/games/daily-challenge/daily-challenge-scoring');
  return {
    SCORE_WEIGHTS: real.SCORE_WEIGHTS,
    calculateWeightedScore: real.calculateWeightedScore,
    challengeToLegacyFormat: vi.fn(),
    deriveChallengeNsfwLevel: vi.fn(() => 1),
    endChallenge: vi.fn(),
    getActiveChallenges: mockGetActiveChallenges,
    getChallengeConfig: vi.fn(),
    getJudgingConfig: vi.fn(),
    getUpcomingSystemChallenge: vi.fn(),
    getEndedActiveChallenges: mockGetEndedActiveChallenges,
    getChallengesToReconcile: mockGetChallengesToReconcile,
  };
});

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  claimChallengeForCompletion: vi.fn(),
  computeDynamicPool: vi.fn(),
  distributePrizes: vi.fn(),
  createChallengeRecord: vi.fn(),
  createChallengeWinner: vi.fn(),
  getChallengeById: vi.fn(),
  getChallengeEntryCount: vi.fn().mockResolvedValue(0),
  getExistingWinnersForRetry: vi.fn(),
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
  resolveEventContext: vi.fn(),
  setChallengeActive: vi.fn(),
  updateChallengeStatus: vi.fn(),
  resetStuckCompletingChallenges: mockResetStuckCompletingChallenges,
}));

vi.mock('~/server/games/daily-challenge/challenge-rewards', () => ({
  distributeParticipationPrizes: vi.fn(),
  promoteChallengeEntries: vi.fn(),
  reconcileCompletedChallenge: mockReconcileCompletedChallenge,
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateArticle: vi.fn(),
  generateCollectionDetails: vi.fn(),
  generateReview: vi.fn(),
  generateWinners: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: vi.fn(),
  getTransactionByExternalId: vi.fn(),
}));

vi.mock('~/server/services/commentsv2.service', () => ({
  upsertComment: vi.fn(),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(),
}));

vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  refundUserChallengeFunds: vi.fn(),
  buildWinnerPayoutTransactions: vi.fn(),
  getChallengeBuzzType: vi.fn(),
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

// challenge-completion.ts imports pickWinnersForChallenge from this module. Only that export is
// overridden — reviewEntries/challengeReviewInternals (used by the tests below) still come from
// the real module, with its own transitive deps already mocked above.
vi.mock('~/server/jobs/daily-challenge-processing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/jobs/daily-challenge-processing')>();
  return { ...actual, pickWinnersForChallenge: mockPickWinnersForChallenge };
});

const { reviewEntries, challengeReviewInternals } = await import(
  '~/server/jobs/daily-challenge-processing'
);
const { runChallengeCompletion } = await import('~/server/jobs/challenge-completion');
const { CHALLENGE_JOB_BATCH_SIZE, CHALLENGE_JOB_CONCURRENCY } = await import(
  '~/shared/constants/challenge.constants'
);

function makeChallenges(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    challengeId: i + 1,
    collectionId: 1000 + i,
    type: 'daily',
    date: new Date(),
    theme: 'test',
    modelId: 1,
    modelVersionIds: [1],
    title: `Challenge ${i + 1}`,
    invitation: '',
    coverUrl: '',
    prizes: [],
    entryPrizeRequirement: 10,
    entryPrize: { buzz: 0, points: 0 },
  })) as never[];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFlipt.mockResolvedValue(true);
  mockLogToAxiom.mockResolvedValue(undefined);
  mockGetEndedActiveChallenges.mockResolvedValue([]);
  mockGetChallengesToReconcile.mockResolvedValue([]);
  mockResetStuckCompletingChallenges.mockResolvedValue(0);
});

describe('reviewEntries at volume', () => {
  it('processes every active challenge and isolates a single failure from the rest', async () => {
    const total = 120;
    mockGetActiveChallenges.mockResolvedValue(makeChallenges(total));

    const processed: number[] = [];
    const spy = vi
      .spyOn(challengeReviewInternals, 'reviewEntriesForChallenge')
      .mockImplementation(async (challenge: never) => {
        const c = challenge as { challengeId: number };
        if (c.challengeId === 7) throw new Error('boom');
        processed.push(c.challengeId);
      });

    await reviewEntries();

    // Anti-drop regression guard: every challenge but the one that threw was processed.
    expect(processed).toHaveLength(total - 1);
    expect(processed).not.toContain(7);
    // The last challenge in a 120-item batch must not be silently dropped (old LIMIT-based
    // selectors truncated below this size).
    expect(processed).toContain(total);
    // All 120 were dispatched to the per-challenge handler regardless of the one throwing.
    expect(spy).toHaveBeenCalledTimes(total);

    spy.mockRestore();
  });

  it('does not warn when active-challenge count is below the batch ceiling', async () => {
    mockGetActiveChallenges.mockResolvedValue(makeChallenges(120));
    vi.spyOn(challengeReviewInternals, 'reviewEntriesForChallenge').mockResolvedValue(undefined);

    await reviewEntries();

    const warningCalls = mockLogToAxiom.mock.calls.filter(([entry]) => entry.type === 'warning');
    expect(warningCalls).toHaveLength(0);
  });

  it('logs a batch-ceiling warning when active-challenge count hits CHALLENGE_JOB_BATCH_SIZE', async () => {
    mockGetActiveChallenges.mockResolvedValue(makeChallenges(CHALLENGE_JOB_BATCH_SIZE));
    vi.spyOn(challengeReviewInternals, 'reviewEntriesForChallenge').mockResolvedValue(undefined);

    await reviewEntries();

    const warningCalls = mockLogToAxiom.mock.calls.filter(([entry]) => entry.type === 'warning');
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toMatchObject({
      name: 'daily-challenge-process-entries',
      count: CHALLENGE_JOB_BATCH_SIZE,
    });
  });
});

// Scale/regression guard for runChallengeCompletion(): the winner-pick loop and the reconcile
// loop must each process every challenge in their batch (no silent drop from a serial loop
// aborting on throw) and isolate a single challenge's failure from the rest. pickWinnersForChallenge
// is swapped out via a partial mock of daily-challenge-processing.ts (only that export overridden,
// see the vi.mock above); reconcileCompletedChallenge is mocked directly since it lives in
// challenge-rewards.ts. Winner-pick is already claim-guarded (claimChallengeForCompletion), so
// concurrent processing is safe.
describe('completion at volume', () => {
  it('picks winners for every ended challenge concurrently, isolating a single failure from the rest', async () => {
    const total = 60;
    mockGetEndedActiveChallenges.mockResolvedValue(makeChallenges(total));
    mockGetChallengesToReconcile.mockResolvedValue([]);

    const done: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    mockPickWinnersForChallenge.mockImplementation(async (challenge: unknown) => {
      const c = challenge as { challengeId: number };
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield a microtask so a genuinely concurrent dispatcher can stack up multiple in-flight
      // calls before any of them resolve; a serial for...of loop can never exceed 1 here.
      await Promise.resolve();
      try {
        if (c.challengeId === 3) throw new Error('boom');
        done.push(c.challengeId);
      } finally {
        inFlight--;
      }
    });

    await runChallengeCompletion();

    // Anti-drop regression guard: every challenge but the one that threw was processed.
    expect(done).toHaveLength(total - 1);
    expect(done).not.toContain(3);
    // The last challenge in the batch must not be silently dropped.
    expect(done).toContain(total);
    // All 60 were dispatched to the per-challenge handler regardless of the one throwing.
    expect(mockPickWinnersForChallenge).toHaveBeenCalledTimes(total);
    // Proves bounded CONCURRENT dispatch (not a serial for...of loop): multiple challenges were
    // in flight at once, capped at CHALLENGE_JOB_CONCURRENCY.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(CHALLENGE_JOB_CONCURRENCY);
  });

  it('reconciles every recently-completed challenge concurrently, isolating a single failure from the rest', async () => {
    const total = 60;
    mockGetEndedActiveChallenges.mockResolvedValue([]);
    mockGetChallengesToReconcile.mockResolvedValue(makeChallenges(total));

    const done: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    mockReconcileCompletedChallenge.mockImplementation(async (challenge: unknown) => {
      const c = challenge as { challengeId: number };
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      try {
        if (c.challengeId === 5) throw new Error('boom');
        done.push(c.challengeId);
        return { promoted: 0, paid: 0, buzzGranted: 0 };
      } finally {
        inFlight--;
      }
    });

    await runChallengeCompletion();

    expect(done).toHaveLength(total - 1);
    expect(done).not.toContain(5);
    expect(done).toContain(total);
    expect(mockReconcileCompletedChallenge).toHaveBeenCalledTimes(total);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(CHALLENGE_JOB_CONCURRENCY);
  });
});
