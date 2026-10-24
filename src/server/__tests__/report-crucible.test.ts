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

const report = () =>
  createReport({
    userId: 41,
    id: 17,
    type: ReportEntity.Crucible,
    reason: ReportReason.TOSViolation,
    details: { violation: 'Spam', comment: 'the title is a slur' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
});

describe('reporting a crucible', () => {
  it('stores the report in the crucible report table, named as a crucible for notifications', async () => {
    await report();

    const { data } = reportCreate.mock.calls[0][0];
    expect(data.crucible).toEqual({ create: { crucibleId: 17 } });
    expect(data.details).toMatchObject({ reportType: 'crucible' });
  });

  it("folds a second report from the same reporter into the first by the crucible's id", async () => {
    await report();

    expect(JSON.stringify(reportFindFirst.mock.calls[0][0].where)).toContain('"crucibleId":17');
  });

  it('leaves a mature-content report Pending for a moderator, and folds a repeat into it', async () => {
    await createReport({
      userId: 41,
      id: 17,
      type: ReportEntity.Crucible,
      reason: ReportReason.NSFW,
      details: { comment: 'adult cover on a PG crucible' },
    });

    expect(reportFindFirst).toHaveBeenCalled();
    expect(reportCreate.mock.calls[0][0].data.status).toBe(ReportStatus.Pending);
  });
});
