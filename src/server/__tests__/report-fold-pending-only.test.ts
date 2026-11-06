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

const report = (foldIntoPendingOnly?: boolean) =>
  createReport({
    userId: -1,
    isModerator: true,
    id: 17,
    type: ReportEntity.Article,
    reason: ReportReason.AdminAttention,
    details: { reason: 'Other', comment: 'automated' },
    foldIntoPendingOnly,
  });

beforeEach(() => {
  vi.clearAllMocks();
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
});

describe('a report that may fold only into an open one', () => {
  it('looks only for a report still waiting for a moderator', async () => {
    await report(true);
    expect(reportFindFirst.mock.calls[0][0].where).toMatchObject({ status: ReportStatus.Pending });
  });

  it('looks for any earlier report otherwise', async () => {
    await report();
    expect(reportFindFirst.mock.calls[0][0].where).not.toHaveProperty('status');
  });
});
