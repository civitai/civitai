import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deepStringProxy, runJobByName } from './test-utils';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockDbRead,
  mockDbWrite,
  mockSysRedis,
  mockRedis,
  mockClickhouseQuery,
  mockClickhouseInsert,
  mockClickhouseExec,
  mockLogToAxiom,
  mockCreateBuzzTransactionMany,
  mockAutoSmitePlayer,
  mockCalculateFervor,
  mockCleanseSmite,
  mockProcessFinalRatings,
  mockClearRatedImages,
  mockGetActiveSlot,
  mockSetActiveSlot,
  mockGetVotingRateLimitConfig,
  mockCounters,
  mockFetch,
} = vi.hoisted(() => {
  const counter = () => ({
    increment: vi.fn().mockResolvedValue(0),
    decrement: vi.fn().mockResolvedValue(0),
    reset: vi.fn().mockResolvedValue(undefined),
    getCount: vi.fn().mockResolvedValue(0),
    getCountBatch: vi.fn().mockResolvedValue(new Map()),
    getAll: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(false),
    key: 'mock',
  });

  return {
    mockDbRead: {
      newOrderPlayer: { findMany: vi.fn().mockResolvedValue([]) },
      newOrderSmite: { findMany: vi.fn().mockResolvedValue([]) },
      image: { findMany: vi.fn().mockResolvedValue([]) },
    },
    mockDbWrite: {
      newOrderPlayer: { update: vi.fn() },
      newOrderSmite: { updateMany: vi.fn() },
      $transaction: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([]),
    },
    mockSysRedis: {
      set: vi.fn(),
      get: vi.fn(),
      del: vi.fn(),
      packed: { get: vi.fn() },
    },
    mockRedis: {
      del: vi.fn(),
      unlink: vi.fn().mockResolvedValue(1),
    },
    mockClickhouseQuery: vi.fn().mockResolvedValue([]),
    mockClickhouseInsert: vi.fn().mockResolvedValue(undefined),
    mockClickhouseExec: vi.fn().mockResolvedValue(undefined),
    mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
    mockCreateBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
    mockAutoSmitePlayer: vi.fn().mockResolvedValue(true),
    mockCalculateFervor: vi.fn(({ correctJudgments, allJudgments }: any) => {
      const ratio = allJudgments > 0 ? correctJudgments / allJudgments : 0;
      return Math.floor(correctJudgments * 100 * Math.max(0.1, ratio));
    }),
    mockCleanseSmite: vi.fn().mockResolvedValue(undefined),
    mockProcessFinalRatings: vi.fn().mockResolvedValue({ status: 'processed', count: 0 }),
    mockClearRatedImages: vi.fn().mockResolvedValue(undefined),
    mockGetActiveSlot: vi.fn().mockResolvedValue('a'),
    mockSetActiveSlot: vi.fn().mockResolvedValue(undefined),
    mockGetVotingRateLimitConfig: vi.fn().mockResolvedValue(null),
    mockCounters: {
      allJudgments: counter(),
      blessedBuzz: counter(),
      correctJudgments: counter(),
      exp: counter(),
      fervor: counter(),
      pendingBuzz: counter(),
      recentlyGrantedBuzz: counter(),
    },
    mockFetch: vi.fn().mockResolvedValue({ ok: true }),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: mockClickhouseQuery,
    $exec: mockClickhouseExec,
    insert: mockClickhouseInsert,
  },
}));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: deepStringProxy('rk'),
  REDIS_SYS_KEYS: deepStringProxy('rsk'),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
}));
vi.mock('~/server/services/games/new-order.service', () => ({
  autoSmitePlayer: mockAutoSmitePlayer,
  calculateFervor: mockCalculateFervor,
  cleanseSmite: mockCleanseSmite,
  processFinalRatings: mockProcessFinalRatings,
  clearRatedImages: mockClearRatedImages,
}));
vi.mock('~/server/games/new-order/utils', () => ({
  allJudgmentsCounter: mockCounters.allJudgments,
  blessedBuzzCounter: mockCounters.blessedBuzz,
  correctJudgmentsCounter: mockCounters.correctJudgments,
  expCounter: mockCounters.exp,
  fervorCounter: mockCounters.fervor,
  pendingBuzzCounter: mockCounters.pendingBuzz,
  recentlyGrantedBuzzCounter: mockCounters.recentlyGrantedBuzz,
  getActiveSlot: mockGetActiveSlot,
  setActiveSlot: mockSetActiveSlot,
  getVotingRateLimitConfig: mockGetVotingRateLimitConfig,
  poolCounters: {},
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: async (tasks: Array<() => Promise<unknown>>) => {
    for (const t of tasks) await t();
  },
}));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));

// Stub global fetch for Discord webhook posts
vi.stubGlobal('fetch', mockFetch);

// Import AFTER mocks
import { newOrderJobs } from '~/server/jobs/new-order-jobs';

const runJob = (name: string) => runJobByName(newOrderJobs, name);

beforeEach(() => {
  vi.clearAllMocks();
  // mockResolvedValueOnce queues persist across clearAllMocks; reset clickhouse
  // query to its default so leftover Once values from a prior test don't leak.
  mockClickhouseQuery.mockReset();
  mockClickhouseQuery.mockResolvedValue([]);
});

// ===========================================================================
// new-order-cleanse-smites
// ===========================================================================
describe('new-order-cleanse-smites', () => {
  it('does nothing when no smites are older than 7 days', async () => {
    mockDbRead.newOrderSmite.findMany.mockResolvedValue([]);

    await runJob('new-order-cleanse-smites');

    expect(mockCleanseSmite).not.toHaveBeenCalled();
  });

  it('cleanses each expired smite via cleanseSmite', async () => {
    mockDbRead.newOrderSmite.findMany.mockResolvedValue([
      { id: 1, targetPlayerId: 100 },
      { id: 2, targetPlayerId: 200 },
    ]);

    await runJob('new-order-cleanse-smites');

    expect(mockCleanseSmite).toHaveBeenCalledTimes(2);
    expect(mockCleanseSmite).toHaveBeenCalledWith({
      id: 1,
      cleansedReason: 'Smite expired',
      playerId: 100,
    });
    expect(mockCleanseSmite).toHaveBeenCalledWith({
      id: 2,
      cleansedReason: 'Smite expired',
      playerId: 200,
    });
  });

  it('filters by 7-day cutoff in the query', async () => {
    await runJob('new-order-cleanse-smites');

    expect(mockDbRead.newOrderSmite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cleansedAt: null,
          createdAt: { lte: expect.any(Date) },
        }),
      })
    );
    // Verify cutoff is roughly 7 days ago
    const call = mockDbRead.newOrderSmite.findMany.mock.calls[0][0];
    const cutoff: Date = call.where.createdAt.lte;
    const daysAgo = (Date.now() - cutoff.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeGreaterThanOrEqual(6.9);
    expect(daysAgo).toBeLessThanOrEqual(7.1);
  });
});

// ===========================================================================
// new-order-daily-reset
// ===========================================================================
describe('new-order-daily-reset', () => {
  it('early-returns when no players exist', async () => {
    mockDbRead.newOrderPlayer.findMany.mockResolvedValue([]);

    await runJob('new-order-daily-reset');

    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockCounters.fervor.reset).not.toHaveBeenCalled();
  });

  it('batches counter fetches, recalculates fervor, and bulk-updates PG', async () => {
    mockDbRead.newOrderPlayer.findMany.mockResolvedValue([
      { userId: 1 },
      { userId: 2 },
    ]);
    mockCounters.correctJudgments.getCountBatch.mockResolvedValue(
      new Map([
        [1, 80],
        [2, 10],
      ])
    );
    mockCounters.allJudgments.getCountBatch.mockResolvedValue(
      new Map([
        [1, 100],
        [2, 100],
      ])
    );
    mockCounters.exp.getCountBatch.mockResolvedValue(
      new Map([
        [1, 5000],
        [2, 200],
      ])
    );
    mockCounters.fervor.getCountBatch.mockResolvedValue(
      new Map([
        [1, 0],
        [2, 0],
      ])
    );

    await runJob('new-order-daily-reset');

    // player 1: correct=80, all=100 → fervor = 80 * 100 * 0.8 = 6400
    // player 2: correct=10, all=100 → fervor = 10 * 100 * 0.1 = 100
    expect(mockCalculateFervor).toHaveBeenCalledWith({
      correctJudgments: 80,
      allJudgments: 100,
    });
    expect(mockCalculateFervor).toHaveBeenCalledWith({
      correctJudgments: 10,
      allJudgments: 100,
    });
    // Players whose fervor changed (0 → non-zero) get reset+increment
    expect(mockCounters.fervor.reset).toHaveBeenCalled();
    expect(mockCounters.fervor.increment).toHaveBeenCalled();
    // PG bulk update fires once per batch
    expect(mockDbWrite.$queryRaw).toHaveBeenCalled();
    // Rated-images cache cleared per player
    expect(mockClearRatedImages).toHaveBeenCalledWith(1);
    expect(mockClearRatedImages).toHaveBeenCalledWith(2);
  });

  it('removes inactive players from the leaderboard when their fervor drops to 0', async () => {
    mockDbRead.newOrderPlayer.findMany.mockResolvedValue([{ userId: 1 }]);
    mockCounters.correctJudgments.getCountBatch.mockResolvedValue(new Map([[1, 0]]));
    mockCounters.allJudgments.getCountBatch.mockResolvedValue(new Map([[1, 0]]));
    mockCounters.exp.getCountBatch.mockResolvedValue(new Map([[1, 1000]]));
    // Previously had fervor; now drops to 0 → must be removed from zset
    mockCounters.fervor.getCountBatch.mockResolvedValue(new Map([[1, 500]]));

    await runJob('new-order-daily-reset');

    // fervor=0 path: only reset is called, no increment
    expect(mockCounters.fervor.reset).toHaveBeenCalledWith({ id: 1 });
    expect(mockCounters.fervor.increment).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// new-order-abuse-detection
// ===========================================================================
describe('new-order-abuse-detection', () => {
  const baseSuspect = {
    userId: 100,
    totalRatings: 500,
    uniqueRatings: 1,
    dominantRating: 1,
    dominantPct: 100,
    correctPct: 30, // low-accuracy bot pattern by default
    avgPerMinute: 20,
    maxPerMinute: 60,
  };

  it('no-ops when ClickHouse returns no suspects', async () => {
    mockClickhouseQuery.mockResolvedValue([]);

    await runJob('new-order-abuse-detection');

    expect(mockLogToAxiom).not.toHaveBeenCalled();
    expect(mockAutoSmitePlayer).not.toHaveBeenCalled();
  });

  it('logs to Axiom but does NOT auto-smite when autoSmiteFromDetectionJob disabled', async () => {
    mockClickhouseQuery.mockResolvedValue([baseSuspect]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteFromDetectionJob: false,
    });

    await runJob('new-order-abuse-detection');

    expect(mockAutoSmitePlayer).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'new-order-abuse-detection-scan',
        details: expect.objectContaining({ autoSmiteEnabled: false, smitedCount: 0 }),
      })
    );
  });

  it('auto-smites strict-signal suspects when autoSmiteFromDetectionJob enabled', async () => {
    mockClickhouseQuery.mockResolvedValue([
      { ...baseSuspect, userId: 100, uniqueRatings: 1 }, // strict
      { ...baseSuspect, userId: 200, uniqueRatings: 5, dominantPct: 95 }, // strict via dominantPct
      { ...baseSuspect, userId: 300, uniqueRatings: 5, dominantPct: 50, maxPerMinute: 60 }, // strict via maxPerMinute
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteFromDetectionJob: true,
    });

    await runJob('new-order-abuse-detection');

    expect(mockAutoSmitePlayer).toHaveBeenCalledTimes(3);
    expect(mockAutoSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 100, source: 'detection-job' })
    );
    expect(mockAutoSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 200, source: 'detection-job' })
    );
    expect(mockAutoSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 300, source: 'detection-job' })
    );
  });

  it('does NOT auto-smite soft signal (avgPerMinute > 15 alone)', async () => {
    mockClickhouseQuery.mockResolvedValue([
      {
        ...baseSuspect,
        userId: 999,
        uniqueRatings: 5,
        dominantPct: 50,
        avgPerMinute: 20, // soft signal
        maxPerMinute: 30, // below 50 threshold
      },
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteFromDetectionJob: true,
    });

    await runJob('new-order-abuse-detection');

    expect(mockAutoSmitePlayer).not.toHaveBeenCalled();
  });

  it('builds smite reason from the signals that matched', async () => {
    mockClickhouseQuery.mockResolvedValue([
      {
        ...baseSuspect,
        userId: 100,
        uniqueRatings: 1,
        dominantPct: 100,
        maxPerMinute: 80,
      },
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteFromDetectionJob: true,
    });

    await runJob('new-order-abuse-detection');

    expect(mockAutoSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('1 unique rating value'),
      })
    );
    expect(mockAutoSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('100% same rating value'),
      })
    );
    expect(mockAutoSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('80 votes in one minute'),
      })
    );
  });

  it('CARVE-OUT: high-accuracy curator (correctPct >= 70) is NOT auto-smited even with skewed distribution', async () => {
    // A legit Knight curates 200 PG images, all rated correctly. Skewed
    // distribution (dominantPct=100) but high accuracy. Must NOT be smited.
    mockClickhouseQuery.mockResolvedValue([
      {
        ...baseSuspect,
        userId: 999,
        uniqueRatings: 1,
        dominantPct: 100,
        correctPct: 95, // high accuracy — curator
        maxPerMinute: 60,
      },
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteFromDetectionJob: true,
    });

    await runJob('new-order-abuse-detection');

    expect(mockAutoSmitePlayer).not.toHaveBeenCalled();
    // Still logged so mods can investigate manually if needed
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'new-order-abuse-detection-scan',
        details: expect.objectContaining({ smitedCount: 0 }),
      })
    );
  });

  it('still smites a bot with low accuracy (correctPct < 70) on skewed distribution', async () => {
    mockClickhouseQuery.mockResolvedValue([
      {
        ...baseSuspect,
        userId: 888,
        uniqueRatings: 1,
        dominantPct: 100,
        correctPct: 25, // low accuracy — bot
        maxPerMinute: 60,
      },
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteFromDetectionJob: true,
    });

    await runJob('new-order-abuse-detection');

    expect(mockAutoSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 888, source: 'detection-job' })
    );
  });

  it('records smited count and per-suspect smite flag in Axiom payload', async () => {
    mockClickhouseQuery.mockResolvedValue([
      { ...baseSuspect, userId: 100, uniqueRatings: 1 }, // strict → smited
      { ...baseSuspect, userId: 200, uniqueRatings: 5, dominantPct: 50, maxPerMinute: 30 }, // not strict
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteFromDetectionJob: true,
    });

    await runJob('new-order-abuse-detection');

    const axiomCall = mockLogToAxiom.mock.calls.find(
      (c: any[]) => c[0].name === 'new-order-abuse-detection-scan'
    );
    expect(axiomCall).toBeTruthy();
    expect(axiomCall?.[0].details.smitedCount).toBe(1);
    const suspects = axiomCall?.[0].details.suspects;
    expect(suspects.find((s: any) => s.userId === 100).smited).toBe(true);
    expect(suspects.find((s: any) => s.userId === 200).smited).toBe(false);
  });
});

// ===========================================================================
// new-order-change-fill-target
// ===========================================================================
describe('new-order-change-fill-target', () => {
  it('flips Knight filling slot from a → b', async () => {
    mockGetActiveSlot.mockResolvedValue('a');

    await runJob('new-order-change-fill-target');

    expect(mockSetActiveSlot).toHaveBeenCalledWith(
      expect.anything(), // NewOrderRankType.Knight
      'filling',
      'b'
    );
  });

  it('flips Knight filling slot from b → a', async () => {
    mockGetActiveSlot.mockResolvedValue('b');

    await runJob('new-order-change-fill-target');

    expect(mockSetActiveSlot).toHaveBeenCalledWith(expect.anything(), 'filling', 'a');
  });
});

// ===========================================================================
// new-order-grant-bless-buzz (P0 — currency-affecting)
// ===========================================================================
describe('new-order-grant-bless-buzz', () => {
  it('early-returns when ClickHouse has no judgments', async () => {
    mockClickhouseQuery.mockResolvedValue([]);

    await runJob('new-order-grant-bless-buzz');

    expect(mockCreateBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('grants buzz to Knights/Templars with balance > 0 and decrements their exp counter', async () => {
    // 3 days ago: two players accumulated balance.
    mockClickhouseQuery
      .mockResolvedValueOnce([
        { userId: 1, balance: 100, totalExp: 100000 },
        { userId: 2, balance: 50, totalExp: 50000 },
      ])
      // Reconciliation pass: no other non-zero counters
      .mockResolvedValueOnce([]);
    mockDbRead.newOrderPlayer.findMany.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
    mockCounters.blessedBuzz.getAll.mockResolvedValue([]); // no reconciliation candidates

    await runJob('new-order-grant-bless-buzz');

    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ toAccountId: 1, amount: 100 }),
        expect.objectContaining({ toAccountId: 2, amount: 50 }),
      ])
    );
    // Each granted player gets their totalExp deducted from the counter
    expect(mockCounters.blessedBuzz.decrement).toHaveBeenCalledWith({ id: 1, value: 100000 });
    expect(mockCounters.blessedBuzz.decrement).toHaveBeenCalledWith({ id: 2, value: 50000 });
    // And their pending/granted counters reset
    expect(mockCounters.pendingBuzz.reset).toHaveBeenCalledWith({ id: 1 });
    expect(mockCounters.recentlyGrantedBuzz.reset).toHaveBeenCalledWith({ id: 1 });
  });

  it('does NOT decrement blessedBuzz for sub-threshold players (balance <= 0); rolls over', async () => {
    mockClickhouseQuery
      .mockResolvedValueOnce([{ userId: 5, balance: 0, totalExp: 200 }])
      .mockResolvedValueOnce([]);
    mockDbRead.newOrderPlayer.findMany.mockResolvedValue([{ userId: 5 }]);
    mockCounters.blessedBuzz.getAll.mockResolvedValue([]);

    await runJob('new-order-grant-bless-buzz');

    // No buzz transaction (filtered out of grantedPlayers)
    expect(mockCreateBuzzTransactionMany).not.toHaveBeenCalled();
    // EXP preserved — no decrement, no recentlyGranted reset
    expect(mockCounters.blessedBuzz.decrement).not.toHaveBeenCalled();
    expect(mockCounters.recentlyGrantedBuzz.reset).not.toHaveBeenCalled();
    // BUT pendingBuzz IS reset so it recalculates next cycle
    expect(mockCounters.pendingBuzz.reset).toHaveBeenCalledWith({ id: 5 });
  });

  it('excludes Acolytes from buzz grants (only Knights and above receive payouts)', async () => {
    mockClickhouseQuery
      .mockResolvedValueOnce([
        { userId: 1, balance: 100, totalExp: 100000 }, // Knight (returned by findMany)
        { userId: 99, balance: 100, totalExp: 100000 }, // Acolyte (filtered out)
      ])
      .mockResolvedValueOnce([]);
    // Only userId=1 returned — the WHERE clause filters out Acolytes
    mockDbRead.newOrderPlayer.findMany.mockResolvedValue([{ userId: 1 }]);
    mockCounters.blessedBuzz.getAll.mockResolvedValue([]);

    await runJob('new-order-grant-bless-buzz');

    // Only userId=1 in transactions
    const calls = mockCreateBuzzTransactionMany.mock.calls[0]?.[0] ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({ toAccountId: 1, amount: 100 })
    );
    // Acolyte (userId=99) gets nothing
    expect(mockCounters.blessedBuzz.decrement).not.toHaveBeenCalledWith({
      id: 99,
      value: expect.anything(),
    });
  });

  it('uses idempotent externalTransactionId keyed on userId + startDate ISO', async () => {
    mockClickhouseQuery
      .mockResolvedValueOnce([{ userId: 1, balance: 100, totalExp: 100000 }])
      .mockResolvedValueOnce([]);
    mockDbRead.newOrderPlayer.findMany.mockResolvedValue([{ userId: 1 }]);
    mockCounters.blessedBuzz.getAll.mockResolvedValue([]);

    await runJob('new-order-grant-bless-buzz');

    const tx = mockCreateBuzzTransactionMany.mock.calls[0]?.[0]?.[0];
    expect(tx.externalTransactionId).toMatch(/^new-order-1-\d{4}-\d{2}-\d{2}T/);
  });

  it('reconciles stale blessedBuzz counters for users with no activity in 3 days', async () => {
    // No judgments this cycle (skip grant step entirely)
    mockClickhouseQuery.mockResolvedValueOnce([]);
    // But there are non-zero blessedBuzz counters
    mockCounters.blessedBuzz.getAll.mockResolvedValue([
      { value: '7', score: 5000 }, // user 7 has stale counter
    ]);
    // Activity scan returns no recent activity for user 7
    mockClickhouseQuery.mockResolvedValueOnce([]);

    await runJob('new-order-grant-bless-buzz');

    // Stale counter reset
    expect(mockCounters.blessedBuzz.reset).toHaveBeenCalledWith({ id: [7] });
    expect(mockCounters.pendingBuzz.reset).toHaveBeenCalledWith({ id: [7] });
  });
});
