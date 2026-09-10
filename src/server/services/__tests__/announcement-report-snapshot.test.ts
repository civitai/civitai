import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');

const announcementFindUnique = dbMock.dbRead.announcement.findUnique;
const reportFindFirst = dbMock.dbWrite.report.findFirst;
const reportCreate = dbMock.dbWrite.report.create;

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears calls but not implementations, so these are re-declared per test
  // rather than left to leak from one case into the next.
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
      details: { announcement: { title: 'innocuous', id: 1234 }, comment: 'spam' } as any,
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
