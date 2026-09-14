import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';
import type * as SystemCache from '~/server/services/system-cache';

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getModeratedTags: vi.fn(async () => []),
}));

const { createReport } = await import('~/server/services/report.service');

const announcementFindUnique = dbMock.dbRead.announcement.findUnique;
const reportFindFirst = dbMock.dbWrite.report.findFirst;
const reportCreate = dbMock.dbWrite.report.create;
const reportUpdate = dbMock.dbWrite.report.update;

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does not reset implementations, so a mockResolvedValue from one test
  // leaks into the next without these.
  announcementFindUnique.mockResolvedValue(null);
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
});

describe('createReport — announcement snapshot', () => {
  it('copies the announcement into details, from the row rather than the client', async () => {
    announcementFindUnique.mockResolvedValue({
      title: 'Free LoRAs',
      content: 'join my telegram',
      userId: 99,
      metadata: { actions: [{ link: 'https://t.me/SomeGroup', linkText: 'Join' }] },
    });

    await createReport({
      userId: 7,
      id: 42,
      type: ReportEntity.Announcement,
      reason: ReportReason.Spam,
      // A forged snapshot from the client must not survive.
      details: {
        announcement: {
          title: 'innocuous',
          content: 'nice',
          link: 'https://safe.example',
          userId: 1,
          id: 1234,
        },
        comment: 'spam',
      } as any,
    });

    const details = reportCreate.mock.calls[0][0].data.details;
    expect(details.announcement).toEqual({
      title: 'Free LoRAs',
      content: 'join my telegram',
      link: 'https://t.me/SomeGroup',
      userId: 99,
    });
    expect(details.comment).toBe('spam');
    // `Record<ReportEntity, …>` guarantees the key exists, not that its value names the right
    // column, so the relation field and the foreign key are pinned against the schema here.
    expect(reportCreate.mock.calls[0][0].data.announcement).toEqual({
      create: { announcementId: 42 },
    });
  });

  it('does not snapshot onto a report that dedupes into an existing one', async () => {
    // `withAdditionalReport` keeps every key but `reportType`, so a snapshot stamped before the
    // dedupe short-circuit appends a second copy of the unbounded HTML content to the existing
    // row — for a duplicate reporter who wrote nothing at all.
    //
    // The row IS read on this path, unlike the snapshot: the sitewide guard needs it, and a
    // guard below the short-circuit would let a second report on a Civitai announcement fold
    // into the first and return success.
    announcementFindUnique.mockResolvedValue({
      title: 'Free LoRAs',
      content: 'join my telegram',
      userId: 99,
      metadata: {},
    });
    reportFindFirst.mockResolvedValue({
      id: 5,
      details: {},
      alsoReportedBy: [],
      previouslyReviewedCount: 0,
    });
    reportUpdate.mockResolvedValue({ id: 5 });

    await createReport({
      userId: 7,
      id: 42,
      type: ReportEntity.Announcement,
      reason: ReportReason.Spam,
      details: {} as any,
    });

    expect(reportUpdate.mock.calls[0][0].data.details).toBeUndefined();
  });

  it('refuses a sitewide Civitai announcement, which has no author', async () => {
    announcementFindUnique.mockResolvedValue({
      title: 'Maintenance window',
      content: 'back shortly',
      userId: null,
      metadata: {},
    });

    await expect(
      createReport({
        userId: 7,
        id: 42,
        type: ReportEntity.Announcement,
        reason: ReportReason.Spam,
        details: { comment: 'spam' } as any,
      })
    ).rejects.toThrow(/cannot be reported/i);

    // Refused before anything was written, and before the dedupe lookup that would otherwise
    // fold a second attempt into an existing report.
    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportFindFirst).not.toHaveBeenCalled();
  });

  it('refuses an announcement that no longer exists', async () => {
    announcementFindUnique.mockResolvedValue(null);

    await expect(
      createReport({
        userId: 7,
        id: 42,
        type: ReportEntity.Announcement,
        reason: ReportReason.Spam,
        details: { comment: 'spam' } as any,
      })
    ).rejects.toThrow(/no longer exists/i);

    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('does not snapshot for any other entity type', async () => {
    await createReport({
      userId: 7,
      id: 42,
      type: ReportEntity.Article,
      reason: ReportReason.Spam,
      details: { comment: 'spam' } as any,
    });

    expect(announcementFindUnique).not.toHaveBeenCalled();
    expect(reportCreate.mock.calls[0][0].data.details.announcement).toBeUndefined();
  });
});
