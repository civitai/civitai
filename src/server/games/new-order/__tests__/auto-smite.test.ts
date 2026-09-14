import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockClickhouseQuery,
  mockGetVotingRateLimitConfig,
  mockSmitePlayer,
  mockHandleLogError,
  mockAbuseReport,
  counterStub,
} = vi.hoisted(() => ({
  mockClickhouseQuery: vi.fn().mockResolvedValue([]),
  mockGetVotingRateLimitConfig: vi.fn().mockResolvedValue(null),
  mockSmitePlayer: vi.fn().mockResolvedValue(undefined),
  mockHandleLogError: vi.fn(),
  mockAbuseReport: vi.fn().mockResolvedValue(undefined),
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
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: mockHandleLogError }));
// The abuse board sink. Stubbed rather than spread-over-actual because the real module builds a
// configured HTTP client at import time from `env`, and every assertion here is about the payload
// this job HANDS it — the contract validation that client performs is asserted directly, against
// `abuseReportInput`, in the report module's own suite.
vi.mock('~/server/services/moderator-app.service', () => ({
  moderatorApp: { abuseReport: mockAbuseReport },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: vi.fn(),
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: async (tasks: Array<() => Promise<unknown>>) => {
    for (const t of tasks) await t();
  },
}));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/env/server', () => ({ env: { DISCORD_WEBHOOK_MOD_ALERTS: undefined } }));

// Import AFTER mocks
import { abuseReportInput, type AbuseReportInput } from '@civitai/moderation';
import { runAbuseDetectionScan } from '~/server/jobs/new-order-jobs';
import { NEW_ORDER_ABUSE_DETECTOR } from '~/server/services/new-order-abuse-detection/report';
import { constants, newOrderConfig } from '~/server/common/constants';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockLogToAxiom = loggingMock.logToAxiom;

const SYSTEM_USER_ID = constants.system.user.id;
const AUTO_SMITE_SIZE = newOrderConfig.smiteSize * 50;

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
  mockAbuseReport.mockReset();
  mockAbuseReport.mockResolvedValue(undefined);
});

/** The single report this run filed, parsed against the wire contract it will really be judged by. */
const filedReport = (): AbuseReportInput => {
  expect(mockAbuseReport).toHaveBeenCalledTimes(1);
  // 🔴 `.parse`, not a cast. `moderatorApp.abuseReport` parses before the network call, so a payload
  // this job builds wrong throws THERE and the whole run is lost — mocking the client away would
  // otherwise make every assertion below pass on a payload the board would never accept.
  return abuseReportInput.parse(mockAbuseReport.mock.calls[0][0]);
};

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
      size: AUTO_SMITE_SIZE,
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
    expect(mockSmitePlayer).toHaveBeenCalledWith(expect.objectContaining({ playerId: 500 }));
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

/**
 * The seam between the scan and the board.
 *
 * The report module's own suite proves the MAPPING is right; none of it can see whether this job
 * hands the mapper the right arguments. These cases build the combined state — a run that smites, a
 * run that does not, a run where a smite threw — and read the payload the client would have parsed.
 */
describe('runAbuseDetectionScan abuse-board report', () => {
  it('files every suspect, not-actioned, when the auto-smite flag is off', async () => {
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 100 }),
      strictSuspect({ userId: 101 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: false,
    });

    await runAbuseDetectionScan();

    const report = filedReport();
    expect(report.detector).toBe(NEW_ORDER_ABUSE_DETECTOR);
    expect(report.findings).toHaveLength(2);
    for (const f of report.findings) {
      expect(f.actioned).toBe(false);
      expect(f.action ?? null).toBeNull();
    }
    expect(report.counters).toMatchObject({ suspects: 2, auto_smited: 0, filed_for_review: 2 });
  });

  it('marks the accounts it smited as actioned and the rest as open, in one report', async () => {
    // 100 is a strict signal and gets smited; 300 is a soft signal (pace only) and does not.
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 100, uniqueRatings: 1, dominantPct: 100 }),
      strictSuspect({ userId: 300, uniqueRatings: 5, dominantPct: 40, avgPerMinute: 20 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
    });

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
    const report = filedReport();
    const byUser = new Map(report.findings.map((f) => [f.userId, f]));
    expect(byUser.get(100)).toMatchObject({ actioned: true, action: 'smite' });
    expect(byUser.get(100)?.reason).toContain('Auto-smited');
    expect(byUser.get(300)?.actioned).toBe(false);
    expect(byUser.get(300)).not.toHaveProperty('action');
    expect(byUser.get(300)?.reason).toContain('No action was taken');
    expect(report.counters).toMatchObject({ suspects: 2, auto_smited: 1, filed_for_review: 1 });
  });

  it('files a suspect whose smite THREW as not-actioned', async () => {
    // 🔴 The outcome, not the intent. 401 was selected for smiting and the write failed, so it is
    // still an open case — filing it as actioned would tell a moderator it had been dealt with.
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 400 }),
      strictSuspect({ userId: 401 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
    });
    mockSmitePlayer.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('db down'));

    await runAbuseDetectionScan();

    const report = filedReport();
    const byUser = new Map(report.findings.map((f) => [f.userId, f]));
    expect(byUser.get(400)).toMatchObject({ actioned: true, action: 'smite' });
    expect(byUser.get(401)?.actioned).toBe(false);
    expect(byUser.get(401)).not.toHaveProperty('action');
    expect(report.counters).toMatchObject({ auto_smited: 1, filed_for_review: 1 });
  });

  it('files a run that found nobody, so a quiet detector is distinguishable from a clean day', async () => {
    mockClickhouseQuery.mockResolvedValue([]);

    await runAbuseDetectionScan();

    const report = filedReport();
    expect(report.findings).toEqual([]);
    expect(report.counters).toMatchObject({ suspects: 0 });
  });

  it('stamps a real, ordered pair of producer timestamps', async () => {
    // The job recorded neither before this change; an unordered pair is refused by the contract and
    // loses the whole run.
    mockClickhouseQuery.mockResolvedValue([strictSuspect()]);

    await runAbuseDetectionScan();

    const report = filedReport();
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
  });

  it('does not fail the run when the board rejects the report', async () => {
    // The smites above are already written; throwing here would mark the job failed and invite a
    // retry of a run whose enforcement half already happened.
    mockClickhouseQuery.mockResolvedValue([strictSuspect()]);
    mockAbuseReport.mockRejectedValue(new Error('400 bad request'));

    await expect(runAbuseDetectionScan()).resolves.toBeUndefined();
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('failed to file its board report')
    );
  });

  it('posts to no Discord webhook', async () => {
    // The surface this replaced. `fetch` is the only way this job could reach one, and nothing else
    // in the scan calls it.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mockClickhouseQuery.mockResolvedValue([strictSuspect()]);

    await runAbuseDetectionScan();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
