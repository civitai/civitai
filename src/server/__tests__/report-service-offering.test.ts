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
