import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clickhouseRef, mockClickhouseQuery, mockGetVotingRateLimitConfig, mockSmitePlayer } =
  vi.hoisted(() => ({
    clickhouseRef: { current: null as null | { $query: ReturnType<typeof vi.fn> } },
    mockClickhouseQuery: vi.fn(),
    mockGetVotingRateLimitConfig: vi.fn(),
    mockSmitePlayer: vi.fn(),
  }));
const { mockHandleLogError, mockAbuseReport } = vi.hoisted(() => ({
  mockHandleLogError: vi.fn(),
  mockAbuseReport: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return clickhouseRef.current;
  },
}));
vi.mock('~/server/games/new-order/utils', () => {
  const counterStub = { key: 'stub' };
  return {
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
  };
});
vi.mock('~/server/services/games/new-order.service', () => ({
  smitePlayer: mockSmitePlayer,
  calculateFervor: vi.fn(),
  cleanseSmite: vi.fn(),
  processFinalRatings: vi.fn(),
  clearRatedImages: vi.fn(),
}));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: mockHandleLogError }));
vi.mock('~/server/services/moderator-app.service', () => ({
  moderatorApp: { abuseReport: mockAbuseReport },
}));
vi.mock('~/server/services/buzz.service', () => ({ createBuzzTransactionMany: vi.fn() }));
vi.mock('~/server/utils/concurrency-helpers', () => ({ limitConcurrency: vi.fn() }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/env/server', () => ({ env: { DISCORD_WEBHOOK_MOD_ALERTS: undefined } }));

import { abuseReportInput, type AbuseReportInput } from '@civitai/moderation';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { runAbuseDetectionScan } from '~/server/jobs/new-order-jobs';

const v1Row = (overrides: Record<string, number> = {}) => ({
  userId: 100,
  totalRatings: 200,
  uniqueRatings: 1,
  dominantRating: 1,
  dominantPct: 100,
  avgPerMinute: 5,
  ...overrides,
});
// The raw shape the Postgres query returns, before the loader maps it.
const v2Row = (overrides: Record<string, unknown> = {}) => ({
  userId: 200,
  totalRatings: 150,
  uniqueRatings: 1,
  dominantAnswer: '4',
  dominantPct: 100,
  avgPerMinute: 3,
  ...overrides,
});

const filed = (): AbuseReportInput => {
  expect(mockAbuseReport).toHaveBeenCalledTimes(1);
  return abuseReportInput.parse(mockAbuseReport.mock.calls[0][0]);
};

beforeEach(() => {
  vi.clearAllMocks();
  clickhouseRef.current = { $query: mockClickhouseQuery };
  mockClickhouseQuery.mockReset().mockResolvedValue([]);
  mockGetVotingRateLimitConfig.mockReset().mockResolvedValue({ autoSmiteAbusers: true });
  mockSmitePlayer
    .mockReset()
    .mockImplementation(async (a: { onSmiteCreated?: (s: { id: number }) => void }) => {
      a.onSmiteCreated?.({ id: 1 });
    });
  mockAbuseReport.mockReset().mockResolvedValue(undefined);
  dbMock.dbRead.$queryRaw.mockReset().mockResolvedValue([]);
});

describe('runAbuseDetectionScan v2 source', () => {
  it('files v2 suspects as not actioned and never smites them, even with autoSmiteAbusers on', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([v2Row()]);

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).not.toHaveBeenCalled();
    const [finding] = filed().findings;
    expect(finding).toMatchObject({ userId: 200, actioned: false });
    expect(finding.action ?? null).toBeNull();
    expect(finding.reason).toContain('Knights v2');
  });

  it('still smites and files v1 suspects as before, with no v2 label', async () => {
    mockClickhouseQuery.mockResolvedValue([v1Row()]);

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
    const [finding] = filed().findings;
    expect(finding).toMatchObject({ userId: 100, actioned: true, action: 'smite' });
    expect(finding.reason).not.toContain('Knights v2');
  });

  it('files an account in both games once per game, and only the v1 finding is actioned', async () => {
    mockClickhouseQuery.mockResolvedValue([v1Row({ userId: 100 })]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([v2Row({ userId: 100 })]);

    await runAbuseDetectionScan();

    const findings = filed().findings;
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => [f.actioned, f.reason.includes('Knights v2')])).toEqual([
      [true, false],
      [false, true],
    ]);
    // The v2 row is not actioned, but it must not claim nothing happened to an account that was
    // smited for v1 in this very run.
    expect(findings[1].reason).toContain('auto-smited by the Knights v1 scan in this run');
    expect(findings[1].reason).not.toContain('No action was taken');
    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
  });

  it('counts the account once in the summary when it is flagged in both games', async () => {
    mockClickhouseQuery.mockResolvedValue([v1Row({ userId: 100 })]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([v2Row({ userId: 100 })]);

    await runAbuseDetectionScan();

    const report = filed();
    expect(report.summary).toContain('1 account matched');
    expect(report.counters).toMatchObject({ suspects: 1, auto_smited: 1, filed_for_review: 0 });
  });

  it('never smites a v2 row that reaches the smite loop', async () => {
    mockClickhouseQuery.mockResolvedValue([{ ...v1Row(), source: 'v2' }]);

    await runAbuseDetectionScan();

    expect(mockSmitePlayer).not.toHaveBeenCalled();
    expect(filed().findings[0].actioned).toBe(false);
  });

  it('still scans v2 when ClickHouse is unavailable', async () => {
    clickhouseRef.current = null;
    dbMock.dbRead.$queryRaw.mockResolvedValue([v2Row()]);

    await runAbuseDetectionScan();

    expect(filed().findings.map((f) => f.userId)).toEqual([200]);
    expect(filed().summary).toContain('Knights v1 scan did not run (ClickHouse unavailable)');
  });

  it('says nothing about coverage when both sources ran', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([v2Row()]);

    await runAbuseDetectionScan();

    expect(filed().summary).not.toMatch(/scan (failed|did not run)/);
  });

  it('files the v2 suspects, says v1 failed, then fails the run when the v1 query fails', async () => {
    mockClickhouseQuery.mockRejectedValue(new Error('clickhouse down'));
    dbMock.dbRead.$queryRaw.mockResolvedValue([v2Row()]);

    await expect(runAbuseDetectionScan()).rejects.toThrow('clickhouse down');

    expect(filed().findings.map((f) => f.userId)).toEqual([200]);
    expect(filed().summary).toContain('Knights v1 scan failed; only v2 votes were scanned.');
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      'new-order-abuse-detection:v1-scan-failed'
    );
  });

  it('fails the run when the v2 query fails and nothing was smited', async () => {
    mockGetVotingRateLimitConfig.mockResolvedValue({ autoSmiteAbusers: false });
    mockClickhouseQuery.mockResolvedValue([v1Row()]);
    dbMock.dbRead.$queryRaw.mockRejectedValue(new Error('pg down'));

    await expect(runAbuseDetectionScan()).rejects.toThrow('pg down');

    expect(mockSmitePlayer).not.toHaveBeenCalled();
    expect(filed().summary).toContain('Knights v2 scan failed; only v1 votes were scanned.');
  });

  // A failed run can be retried, and a retry would smite the same accounts again.
  it('files and smites the v1 suspects, says v2 failed, and does not fail the run once it has smited', async () => {
    mockClickhouseQuery.mockResolvedValue([v1Row()]);
    dbMock.dbRead.$queryRaw.mockRejectedValue(new Error('pg down'));

    await expect(runAbuseDetectionScan()).resolves.toBeUndefined();

    expect(mockSmitePlayer).toHaveBeenCalledTimes(1);
    expect(filed().findings.map((f) => f.userId)).toEqual([100]);
    expect(filed().summary).toContain('Knights v2 scan failed; only v1 votes were scanned.');
    expect(mockHandleLogError).toHaveBeenCalledWith(
      expect.any(Error),
      'new-order-abuse-detection:v2-scan-failed'
    );
  });

  it('fails the run, filing nothing, when every source that ran failed', async () => {
    mockClickhouseQuery.mockRejectedValue(new Error('clickhouse down'));
    dbMock.dbRead.$queryRaw.mockRejectedValue(new Error('pg down'));

    await expect(runAbuseDetectionScan()).rejects.toThrow();
    expect(mockAbuseReport).not.toHaveBeenCalled();
  });
});
