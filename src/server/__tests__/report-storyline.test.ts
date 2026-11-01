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

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.storyline.findUnique.mockResolvedValue({ id: 17 } as never);
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
});

describe('reporting a storyline', () => {
  it('answers not found for an id that is not a storyline, and files nothing', async () => {
    dbMock.dbRead.storyline.findUnique.mockResolvedValueOnce(null);
    await expect(
      createReport({
        userId: 41,
        id: 999,
        type: ReportEntity.Storyline,
        reason: ReportReason.TOSViolation,
        details: { comment: 'gone' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('stores the report in the storyline report table, named as a storyline for notifications', async () => {
    await createReport({
      userId: 41,
      id: 17,
      type: ReportEntity.Storyline,
      reason: ReportReason.TOSViolation,
      details: { violation: 'Hate speech', comment: 'the title is a slur' },
    });

    const { data } = reportCreate.mock.calls[0][0];
    expect(data.storyline).toEqual({ create: { storylineId: 17 } });
    expect(data.details).toMatchObject({ reportType: 'storyline' });
    expect(JSON.stringify(reportFindFirst.mock.calls[0][0].where)).toContain('"storylineId":17');
  });

  // Nothing automated rates a storyline from a report (no tag votes, no nsfw flag), so a
  // mature-content report must reach a moderator. Without this it is filed Actioned and never
  // shown in the queue.
  it('leaves a mature-content report Pending for a moderator', async () => {
    await createReport({
      userId: 41,
      id: 17,
      type: ReportEntity.Storyline,
      reason: ReportReason.NSFW,
      details: { comment: 'adult title on a PG storyline' },
    });

    expect(reportFindFirst).toHaveBeenCalled();
    expect(reportCreate.mock.calls[0][0].data.status).toBe(ReportStatus.Pending);
  });

  // Awaiting a moderator is what routes an NSFW report through the dedupe at all: an image's or a
  // model's skips it and is filed afresh each time.
  it('folds a second mature-content report into the open one instead of filing another', async () => {
    reportFindFirst.mockResolvedValueOnce({
      id: 9,
      alsoReportedBy: [],
      previouslyReviewedCount: 0,
      details: {},
    } as never);
    dbMock.dbWrite.report.update.mockResolvedValueOnce({ id: 9 } as never);

    const result = await createReport({
      userId: 42,
      id: 17,
      type: ReportEntity.Storyline,
      reason: ReportReason.NSFW,
      details: { comment: 'adult title on a PG storyline' },
    });

    expect(result).toEqual({ id: 9 });
    expect(reportCreate).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.report.update.mock.calls[0][0]).toMatchObject({
      where: { id: 9 },
      data: { alsoReportedBy: [42] },
    });
  });
});
