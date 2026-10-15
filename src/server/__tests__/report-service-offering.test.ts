import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const reportCreate = vi.fn();
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ report: { create: (...args: unknown[]) => reportCreate(...args) } })
);

const reportFindFirst = dbMock.dbWrite.report.findFirst;

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');

const report = (reason: ReportReason = ReportReason.TOSViolation) =>
  createReport({
    userId: 41,
    id: 17,
    type: ReportEntity.ServiceOffering,
    reason,
    details: { violation: 'Spam', comment: 'asks buyers to pay off-site' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  reportFindFirst.mockResolvedValue(null);
  dbMock.dbRead.serviceOffering.findUnique.mockResolvedValue({ id: 17 } as never);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
});

describe('reporting a service offering', () => {
  it('stores the report in the offering report table, named as an offering', async () => {
    await report();

    const { data } = reportCreate.mock.calls[0][0];
    expect(data.serviceOffering).toEqual({ create: { serviceOfferingId: 17 } });
    expect(data.details).toMatchObject({ reportType: 'serviceOffering' });
  });

  it("folds a second report from the same reporter into the first by the offering's id", async () => {
    await report();

    expect(JSON.stringify(reportFindFirst.mock.calls[0][0].where)).toContain(
      '"serviceOfferingId":17'
    );
  });

  // Offerings have no automatic NSFW handling, so a mature-content report must reach a moderator.
  it('leaves a mature-content report Pending for a moderator, and folds a repeat into it', async () => {
    await report(ReportReason.NSFW);

    expect(reportFindFirst).toHaveBeenCalled();
    expect(reportCreate.mock.calls[0][0].data.status).toBe(ReportStatus.Pending);
  });
});

// The apps/moderator queue for offering reports exists (/reports/service), so the public input takes
// them. If that queue is ever removed, refuse them here again rather than let reports land unseen.
describe('filing an offering report', () => {
  it('is accepted at the public input', async () => {
    const { createReportInputSchema } = await import('~/server/schema/report.schema');
    const parsed = createReportInputSchema.safeParse({
      type: ReportEntity.ServiceOffering,
      id: 17,
      reason: ReportReason.TOSViolation,
      details: { violation: 'Spam', comment: 'asks buyers to pay off-site' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('reporting a service that does not exist', () => {
  it('is a 404 before any report is written, not a failed join row', async () => {
    dbMock.dbRead.serviceOffering.findUnique.mockResolvedValue(null as never);
    await expect(report()).rejects.toThrow('That service no longer exists.');
    expect(reportCreate).not.toHaveBeenCalled();
  });
});
