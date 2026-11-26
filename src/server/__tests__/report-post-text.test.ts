import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOS_VIOLATIONS } from '~/server/schema/report.schema';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CHILD_SAFETY_VIOLATIONS,
  MINOR_SEXUALIZATION_VIOLATION,
} from '@civitai/shared/post-text-report';

const reportCreate = vi.fn();
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ report: { create: (...args: unknown[]) => reportCreate(...args) } })
);
const reportFindFirst = dbMock.dbWrite.report.findFirst;
const textFind = dbMock.dbWrite.postText.findUnique;

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const textVisible = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ postId: 5 })));
vi.mock('~/server/services/post-viewer-visibility.service', () => ({
  assertPostTextVisible: textVisible,
}));

const { createReport } = await import('~/server/services/report.service');
const { createReportHandler } = await import('~/server/controllers/report.controller');

const AUTHOR = 30;
const READER = 41;
const TEXT = 17;
const POST = 5;

const report = (
  userId: number,
  reason: Parameters<typeof createReport>[0]['reason'] = ReportReason.TOSViolation
) =>
  createReport({
    userId,
    id: TEXT,
    type: ReportEntity.PostText,
    reason,
    // Its details shape follows the reason, which varies here.
    details: { violation: 'Graphic violence', comment: 'slide three' } as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  textFind.mockResolvedValue({
    postId: POST,
    userId: AUTHOR,
    index: 3,
    content: '<p>The reported words.</p>',
    post: { userId: AUTHOR },
  } as never);
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, status: ReportStatus.Pending, details: {} });
});

describe('reporting a storyline text', () => {
  it("refuses the text's author and files nothing", async () => {
    await expect(report(AUTHOR)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportFindFirst).not.toHaveBeenCalled();
  });

  it("refuses the post's owner even where the text names someone else", async () => {
    textFind.mockResolvedValueOnce({ postId: POST, userId: 99, post: { userId: AUTHOR } } as never);
    await expect(report(AUTHOR)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('answers not found for a text that is gone', async () => {
    textFind.mockResolvedValueOnce(null);
    await expect(report(READER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("files a reader's report against the text and its post, for a moderator", async () => {
    await report(READER, ReportReason.NSFW);

    const { data } = reportCreate.mock.calls[0][0];
    expect(data.postText).toEqual({ create: { postTextId: TEXT, postId: POST } });
    expect(data.status).toBe(ReportStatus.Pending);
    expect(data.details).toMatchObject({ reportType: 'postText' });
    expect(JSON.stringify(reportFindFirst.mock.calls[0][0].where)).toContain('"postTextId":17');
  });

  // The author can still edit or delete the text, so the report keeps the words it was about.
  it('keeps the words as reported, from the row, never from what the reporter sent', async () => {
    await createReport({
      userId: READER,
      id: TEXT,
      type: ReportEntity.PostText,
      reason: ReportReason.TOSViolation,
      details: {
        violation: 'Graphic violence',
        postText: { content: 'forged', index: 0, postId: 1 },
      } as never,
    });

    expect(reportCreate.mock.calls[0][0].data.details.postText).toEqual({
      content: '<p>The reported words.</p>',
      index: 3,
      postId: POST,
    });
  });

  // A dismissed report must not swallow a later one: the author may have edited the text since.
  it('folds only into a report still waiting for a moderator', async () => {
    await report(READER);
    expect(reportFindFirst.mock.calls[0][0].where).toMatchObject({ status: ReportStatus.Pending });
  });

  it('drops a snapshot a folded-in reporter sent', async () => {
    reportFindFirst.mockResolvedValueOnce({
      id: 9,
      alsoReportedBy: [],
      previouslyReviewedCount: 0,
      details: {},
    } as never);
    dbMock.dbWrite.report.update.mockResolvedValueOnce({ id: 9 } as never);

    await createReport({
      userId: READER,
      id: TEXT,
      type: ReportEntity.PostText,
      reason: ReportReason.TOSViolation,
      details: { violation: 'Graphic violence', postText: { content: 'forged' } } as never,
    });

    expect(reportCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(dbMock.dbWrite.report.update.mock.calls[0][0])).not.toContain('forged');
  });
});

describe('report.create on a storyline text', () => {
  const ctx = { user: { id: READER, isModerator: false }, track: { report: vi.fn() } } as never;
  const call = () =>
    createReportHandler({
      input: {
        type: ReportEntity.PostText,
        id: TEXT,
        reason: ReportReason.TOSViolation,
        details: { violation: 'Graphic violence' },
      } as never,
      ctx,
    });

  it('files nothing for a text the reporter is not shown', async () => {
    textVisible.mockRejectedValueOnce(
      Object.assign(new Error('Text not found'), { code: 'NOT_FOUND' })
    );
    await expect(call()).rejects.toThrow('Text not found');
    expect(textVisible).toHaveBeenCalledWith(TEXT, ctx);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('files the report for a text the reporter is shown', async () => {
    await call();
    expect(reportCreate).toHaveBeenCalledTimes(1);
  });
});

// The moderator app routes a minor-sexualization report on a text to the CSAM queue by this string.
it('names a violation the report form offers', () => {
  expect(TOS_VIOLATIONS).toContain(MINOR_SEXUALIZATION_VIOLATION);
  expect(TOS_VIOLATIONS).toEqual(expect.arrayContaining([...CHILD_SAFETY_VIOLATIONS]));
});
