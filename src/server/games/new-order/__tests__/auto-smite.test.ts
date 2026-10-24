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
  mockSmitePlayer: vi.fn(),
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

/**
 * 🔴 A SUCCESSFUL `smitePlayer` FIRES `onSmiteCreated`, SO A FAKE THAT ONLY RESOLVES IS NOT ONE.
 *
 * The real service commits the smite row and invokes the hook there, before a tail of non-durable
 * work that can throw with the penalty already live (measured in `smite-durable-write.test.ts`).
 * The job records board membership from that hook, so a fake that resolves WITHOUT firing it models
 * a call that wrote nothing — and every "this one smites" case here would silently be asserting the
 * failure path while reading like the success one.
 */
type SmiteArgs = { playerId: number; onSmiteCreated?: (smite: { id: number }) => unknown };
let nextSmiteId = 1;
const smiteSucceeds = async (args: SmiteArgs) => {
  args.onSmiteCreated?.({ id: nextSmiteId++ });
  return undefined;
};

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
  mockSmitePlayer.mockImplementation(smiteSucceeds);
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
    // The WHOLE argument set, not a subset — so dropping the durable-write hook fails here as well
    // as in the outcome cases below, which is the cheaper place to notice it.
    expect(mockSmitePlayer).toHaveBeenCalledWith({
      playerId: 100,
      modId: SYSTEM_USER_ID,
      reason: expect.stringContaining('only 1 unique rating value'),
      size: AUTO_SMITE_SIZE,
      onSmiteCreated: expect.any(Function),
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
      .mockImplementationOnce(smiteSucceeds)
      .mockRejectedValueOnce(new Error('db down'))
      .mockImplementationOnce(smiteSucceeds);

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(3);
    // 🔴 The WHOLE key, not a substring, and the player id in the DETAILS. `handleLogError`'s second
    // argument becomes the Axiom `name` an alert matches on; this used to interpolate the id into a
    // free-text sentence there, which is both unmatchable and unbounded in cardinality — one distinct
    // alert name per failing player. A `stringContaining` assertion would keep passing if someone put
    // the sentence back.
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      'new-order-abuse-detection:auto-smite-failed',
      expect.objectContaining({ playerId: 401, smited: false })
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

  /**
   * 🔴 THE TWO SHAPES OF "THE SMITE CALL THREW", AND THEY MUST BE ASSERTED AS A PAIR.
   *
   * `smitePlayer` commits the smite ROW and then does a pile of non-durable work — a count, a
   * possible career reset, a Redis counter increment, a signal, a notification — any of which can
   * throw with the penalty already live. So a throw says nothing on its own about whether the account
   * was penalised, and the two cases want OPPOSITE rows on the board:
   *
   *  - threw with NOTHING written  → open case, `actioned: false`. Claiming otherwise tells a
   *    moderator an account was dealt with when it was not.
   *  - threw AFTER the row landed  → a live penalty, `actioned: true`. Filing it open puts "No action
   *    was taken by this scan" beside a smite that already exists and invites a second one.
   *
   * Either case alone passes with the flag collapsed in the direction it happens to want — recording
   * membership after the `await` passes the first and fails the second; recording it before the call
   * passes the second and fails the first. The pair is what pins membership to the durable write.
   */
  it('files a suspect whose smite threw with NOTHING WRITTEN as not-actioned', async () => {
    // 401 was selected for smiting and the row was never created, so it is still an open case.
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
    // Rejects without ever invoking `onSmiteCreated` — the shape of the `create` itself failing.
    mockSmitePlayer
      .mockImplementationOnce(smiteSucceeds)
      .mockRejectedValueOnce(new Error('db down'));

    await runAbuseDetectionScan();

    const report = filedReport();
    const byUser = new Map(report.findings.map((f) => [f.userId, f]));
    expect(byUser.get(400)).toMatchObject({ actioned: true, action: 'smite' });
    expect(byUser.get(401)?.actioned).toBe(false);
    expect(byUser.get(401)).not.toHaveProperty('action');
    expect(byUser.get(401)?.reason).toContain('No action was taken');
    expect(report.counters).toMatchObject({ auto_smited: 1, filed_for_review: 1 });
  });

  it('files a suspect whose smite ROW WAS WRITTEN but whose call then threw as actioned', async () => {
    // 501's penalty is live in the database; only the non-durable tail failed. The board must say so,
    // or a moderator reads an already-penalised account as an untouched one.
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 500 }),
      strictSuspect({ userId: 501 }),
    ]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
    });
    mockSmitePlayer
      .mockImplementationOnce(smiteSucceeds)
      .mockImplementationOnce(
        async (args: { onSmiteCreated?: (smite: { id: number }) => unknown }) => {
          // The durable half succeeded — this is the signal `smitePlayer` fires the instant the row is
          // committed — and the throw is everything after it.
          args.onSmiteCreated?.({ id: 987 });
          throw new Error('counter backend unavailable');
        }
      );

    await runAbuseDetectionScan();

    const report = filedReport();
    const byUser = new Map(report.findings.map((f) => [f.userId, f]));
    expect(byUser.get(500)).toMatchObject({ actioned: true, action: 'smite' });
    expect(byUser.get(501)).toMatchObject({ actioned: true, action: 'smite' });
    expect(byUser.get(501)?.reason).toContain('Auto-smited');
    expect(byUser.get(501)?.reason).not.toContain('No action was taken');
    expect(report.counters).toMatchObject({ suspects: 2, auto_smited: 2, filed_for_review: 0 });
    // The failure is still recorded — a live penalty whose tail broke is not a silent success.
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      'new-order-abuse-detection:auto-smite-failed',
      expect.objectContaining({ playerId: 501, smited: true })
    );
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

  /**
   * 🔴 THE TWO HALVES OF THE REPORT-FAILURE SPLIT, AND THEY MUST BE ASSERTED AS A PAIR.
   *
   * Either one alone passes with the branch collapsed in the direction it happens to want, so the
   * pair is what pins the condition rather than the outcome: rethrow when the run produced nothing
   * but the report, swallow only when smites are already written.
   *
   * The consequence of getting the first one wrong is invisible by construction. A swallowed failure
   * on a run that smited nobody means the run produced no output at all and still returned success —
   * the job's error counter never moves, so the detector can be dark indefinitely with no signal.
   */
  it('PROPAGATES a report failure when the run smited nobody, so the job registers an error', async () => {
    // The flag is off, so nothing was written and there is nothing a failed run would be retrying.
    // This is the shape of the overwhelming majority of runs.
    mockClickhouseQuery.mockResolvedValue([strictSuspect()]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: false,
    });
    mockAbuseReport.mockRejectedValue(new Error('400 bad request'));

    await expect(runAbuseDetectionScan()).rejects.toThrow('400 bad request');
    expect(mockSmitePlayer).not.toHaveBeenCalled();
  });

  it('SWALLOWS a report failure when smites are already written, and logs under a stable key', async () => {
    // The one case the swallow is for: the enforcement half already happened, so failing the run
    // asks for a retry of work that is done.
    mockClickhouseQuery.mockResolvedValue([strictSuspect({ userId: 100 })]);
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 1,
      perHour: 1,
      perDay: 1,
      autoSmiteAbusers: true,
    });
    mockAbuseReport.mockRejectedValue(new Error('400 bad request'));

    await expect(runAbuseDetectionScan()).resolves.toBeUndefined();
    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
    // 🔴 The WHOLE key, not a substring. `handleLogError`'s second argument becomes the Axiom `name`
    // an alert would match on, so a free-text sentence there is unalertable — which is what this
    // used to pass. A `stringContaining` assertion would keep passing if someone put the sentence
    // back around the key.
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      'new-order-abuse-detection:report-failed',
      expect.objectContaining({ smited: 1, suspects: 1 })
    );
  });

  it('logs the scan to Axiom as an AGGREGATE, with no per-account array', async () => {
    // 🔴 Pinned as the whole `details` key set, not as an absence check for today's field name: a
    // check that only forbids `suspects` cannot see per-account detail coming back under any other
    // key, and the failure would be a duplicated disclosure rather than a red test. Both precedents
    // log run-level counts beside their board post; the per-account half belongs on the board, which
    // renders it with attribution and reviewed-state that a log line has no way to carry.
    mockClickhouseQuery.mockResolvedValue([
      strictSuspect({ userId: 100, totalRatings: 200 }),
      strictSuspect({ userId: 101, totalRatings: 50 }),
    ]);

    await runAbuseDetectionScan();

    const scanLog = mockLogToAxiom.mock.calls
      .map((c: unknown[]) => c[0] as { name?: string; details?: Record<string, unknown> })
      .find((p) => p?.name === 'new-order-abuse-detection-scan');
    expect(scanLog, 'the scan must still log its run to Axiom').toBeDefined();
    expect(Object.keys(scanLog?.details ?? {}).sort()).toEqual(['ratings', 'suspectCount']);
    expect(scanLog?.details).toMatchObject({ suspectCount: 2, ratings: 250 });
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
