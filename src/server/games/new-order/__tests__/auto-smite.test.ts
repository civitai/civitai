import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockClickhouseQuery,
  mockGetVotingRateLimitConfig,
  mockSmitePlayer,
  mockLogToAxiom,
  mockHandleLogError,
  counterStub,
} = vi.hoisted(() => ({
  mockClickhouseQuery: vi.fn().mockResolvedValue([]),
  mockGetVotingRateLimitConfig: vi.fn().mockResolvedValue(null),
  mockSmitePlayer: vi.fn().mockResolvedValue(undefined),
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  mockHandleLogError: vi.fn(),
  counterStub: {
    increment: vi.fn(),
    decrement: vi.fn(),
    reset: vi.fn(),
    getCount: vi.fn(),
    getCountBatch: vi.fn(),
    getAll: vi.fn(),
    exists: vi.fn(),
    key: 'stub',
  },
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: mockClickhouseQuery },
}));
vi.mock('~/server/games/new-order/utils', () => ({
  allJudgmentsCounter: counterStub,
  blessedBuzzCounter: counterStub,
  correctJudgmentsCounter: counterStub,
  expCounter: counterStub,
  fervorCounter: counterStub,
  pendingBuzzCounter: counterStub,
  recentlyGrantedBuzzCounter: counterStub,
  getActiveSlot: vi.fn(),
  setActiveSlot: vi.fn(),
  getVotingRateLimitConfig: mockGetVotingRateLimitConfig,
  poolCounters: {},
}));
vi.mock('~/server/services/games/new-order.service', () => ({
  smitePlayer: mockSmitePlayer,
  calculateFervor: vi.fn(),
  cleanseSmite: vi.fn(),
  processFinalRatings: vi.fn(),
  clearRatedImages: vi.fn(),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: mockHandleLogError }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { newOrderPlayer: { findMany: vi.fn() }, newOrderSmite: { findMany: vi.fn() } },
  dbWrite: {},
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: async (tasks: Array<() => Promise<unknown>>) => {
    for (const t of tasks) await t();
  },
}));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/env/server', () => ({ env: { DISCORD_WEBHOOK_MOD_ALERTS: undefined } }));

// Import AFTER mocks
import { runAbuseDetectionScan } from '~/server/jobs/new-order-jobs';
import { constants } from '~/server/common/constants';

const SYSTEM_USER_ID = constants.system.user.id;

const strictSuspect = (overrides: Partial<Record<string, number>> = {}) => ({
  userId: 100,
  totalRatings: 200,
  uniqueRatings: 1,
  dominantRating: 1,
  dominantPct: 100,
  avgPerMinute: 5,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockClickhouseQuery.mockReset();
  mockClickhouseQuery.mockResolvedValue([]);
  mockGetVotingRateLimitConfig.mockReset();
  mockGetVotingRateLimitConfig.mockResolvedValue(null);
  mockSmitePlayer.mockReset();
  mockSmitePlayer.mockResolvedValue(undefined);
});

describe('runAbuseDetectionScan auto-smite branch', () => {
  it('does not smite when autoSmiteAbusers flag is off', async () => {
    mockClickhouseQuery.mockResolvedValue([strictSuspect()]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: false,
    });

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).not.toHaveBeenCalled();
  });

  it('does not smite when config is null (default off)', async () => {
    mockClickhouseQuery.mockResolvedValue([strictSuspect()]);
    mockGetVotingRateLimitConfig.mockResolvedValue(null);

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).not.toHaveBeenCalled();
  });

  it('smites suspects matching uniqueRatings === 1 when flag is on', async () => {
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 100, uniqueRatings: 1, dominantPct: 100 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
    });

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
    expect(mockSmitePlayer).toHaveBeenCalledWith({
      playerId: 100,
      modId: SYSTEM_USER_ID,
      reason: expect.stringContaining('only 1 unique rating value'),
      size: 1,
    });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'new-order-auto-smite',
        details: expect.objectContaining({ playerId: 100, source: 'detection-job' }),
      })
    );
  });

  it('smites suspects matching dominantPct >= smiteDominantPct when flag is on', async () => {
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 200, uniqueRatings: 3, dominantPct: 95 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
      abuseDetection: { smiteDominantPct: 95 },
    });

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
    expect(mockSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: 200,
        modId: SYSTEM_USER_ID,
        reason: expect.stringContaining('95% same rating value'),
      })
    );
  });

  it('does not smite soft signals (avgPerMinute > 15 only, dominantPct < 95)', async () => {
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 300, uniqueRatings: 5, dominantPct: 40, avgPerMinute: 20 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
    });

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).not.toHaveBeenCalled();
  });

  it('does not smite below smiteDominantPct threshold', async () => {
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 350, uniqueRatings: 3, dominantPct: 92 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
      abuseDetection: { smiteDominantPct: 95 },
    });

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).not.toHaveBeenCalled();
  });

  it('honors custom thresholds from abuseDetection config (looser smite filter)', async () => {
    // Lower smiteDominantPct to 80 — should smite a user that the default 95
    // would skip. Verifies the Redis-backed threshold actually flows through.
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 500, uniqueRatings: 3, dominantPct: 82 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
      abuseDetection: { smiteDominantPct: 80 },
    });

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
    expect(mockSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 500 })
    );
  });

  it('honors custom smiteMaxUniqueRatings (allows 2-value spam as bot signal)', async () => {
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 600, uniqueRatings: 2, dominantPct: 60 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
      abuseDetection: { smiteMaxUniqueRatings: 2 },
    });

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
    expect(mockSmitePlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: 600,
        reason: expect.stringContaining('only 2 unique rating value(s)'),
      })
    );
  });

  it('continues processing remaining targets when smitePlayer throws on one', async () => {
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 400 }),
      strictSuspect({ userId: 401 }),
      strictSuspect({ userId: 402 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
    });
    mockSmitePlayer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(3);
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('auto-smite failed for player 401')
    );
  });
});
