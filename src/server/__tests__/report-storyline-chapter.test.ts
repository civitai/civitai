import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const reportCreate = vi.fn();
const postUpdate = vi.fn();
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    report: { create: (...args: unknown[]) => reportCreate(...args) },
    post: { update: (...args: unknown[]) => postUpdate(...args) },
  })
);

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');

const reportPost = () =>
  createReport({
    userId: 41,
    id: 500,
    type: ReportEntity.Post,
    reason: ReportReason.NSFW,
    details: { comment: 'explicit chapter in a PG storyline' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.report.findFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
});

describe("a storyline chapter's mature-content report", () => {
  it('stays Pending for a moderator when the post is a chapter', async () => {
    dbMock.dbRead.storylineChapter.findUnique.mockResolvedValue({ id: 11 } as never);
    await reportPost();
    expect(reportCreate.mock.calls[0][0].data.status).toBe(ReportStatus.Pending);
    expect(reportCreate.mock.calls[0][0].data.post).toEqual({ create: { postId: 500 } });
  });

  it('is Actioned at once, as before, when the post is no chapter', async () => {
    dbMock.dbRead.storylineChapter.findUnique.mockResolvedValue(null);
    await reportPost();
    expect(reportCreate.mock.calls[0][0].data.status).toBe(ReportStatus.Actioned);
  });
});
