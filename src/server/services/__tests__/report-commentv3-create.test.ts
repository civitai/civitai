import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { createReportInputSchema } from '~/server/schema/report.schema';

// A report on a comment links it through CommentV3Report.commentId, and a deleted comment, whose
// placeholder row is still there to link to, takes no new report.

const reportCreate = vi.fn();
const txQueryRaw = vi.fn();
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ report: { create: (...args: unknown[]) => reportCreate(...args) }, $queryRaw: txQueryRaw })
);
vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');

const report = () =>
  createReport({
    userId: 7,
    id: 41,
    type: ReportEntity.CommentV3,
    reason: ReportReason.TOSViolation,
    details: { violation: 'Spam' },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.report.findFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
});

describe('reporting a comment', () => {
  const lookup = () => {
    const [sql, ...values] = txQueryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    return { sql: sql.join('?'), values };
  };

  it('links the report to the live comment by commentId, holding it until the report commits', async () => {
    txQueryRaw.mockResolvedValueOnce([{ id: 41 }]);
    await report();
    expect(reportCreate.mock.calls[0][0].data.commentV3).toEqual({ create: { commentId: 41 } });
    expect(lookup().sql).toContain('FOR SHARE');
    expect(lookup().values[0]).toBe(41);
  });

  it('refuses a deleted comment, and stores nothing', async () => {
    txQueryRaw.mockResolvedValueOnce([]);
    await expect(report()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(lookup().sql).toContain('"deletedAt" IS NULL');
    expect(reportCreate).not.toHaveBeenCalled();
  });

  const parses = (type: string) =>
    createReportInputSchema.safeParse({
      type,
      id: 1,
      reason: ReportReason.TOSViolation,
      details: { violation: 'spam' },
    }).success;

  it.each(['comment', 'commentV2'])('refuses the old %s type at the input', (type) => {
    expect(parses(type)).toBe(false);
  });

  it('accepts the same payload as commentV3', () => {
    expect(parses('commentV3')).toBe(true);
  });
});
