import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TagService from '~/server/services/tag.service';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { addTagVotes, reportCreate, getModeratedTags } = vi.hoisted(() => ({
  addTagVotes: vi.fn(async () => undefined),
  reportCreate: vi.fn(),
  getModeratedTags: vi.fn(),
}));

dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    report: { create: (...args: unknown[]) => reportCreate(...args) },
    image: { update: vi.fn(), findUnique: vi.fn(async () => null) },
    model: { update: vi.fn() },
  })
);

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags }));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  addTagVotes,
}));

const { createReportHandler } = await import('~/server/controllers/report.controller');

const member = { id: 41, isModerator: false, emailVerified: new Date('2024-01-01') };
const newSignup = { ...member, emailVerified: null, meta: { emailVerificationRequired: true } };
const olderUnverified = { ...member, emailVerified: null };

const fileNsfwReport = (user: unknown, type: ReportEntity.Image | ReportEntity.Model) =>
  createReportHandler({
    input: { type, id: 63, reason: ReportReason.NSFW, details: { tags: ['partial nudity'] } },
    ctx: { user, track: { report: vi.fn() } } as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.report.findFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
  // The reported tag rates above the image, so an image report's rating request has work to do.
  getModeratedTags.mockResolvedValue([{ name: 'partial nudity', nsfwLevel: 4 }]);
  dbMock.dbWrite.image.findFirst.mockResolvedValue({ nsfwLevel: 1, nsfwLevelLocked: true });
});

const ratingRequest = dbMock.dbWrite.imageRatingRequest.upsert;
const imageUpdate = dbMock.dbWrite.image.update;
const existingReportLookup = dbMock.dbWrite.report.findFirst;
const reportUpdate = dbMock.dbWrite.report.update;
const createdStatus = () => reportCreate.mock.calls[0]?.[0]?.data?.status;

const earlierReport = { id: 80, alsoReportedBy: [52], previouslyReviewedCount: 0, details: {} };
/** `report.findFirst` over these rows, honouring the status filter the way the database would. */
const storedReports =
  (rows: { status: ReportStatus }[]) =>
  async ({ where }: { where: { status?: ReportStatus } }) =>
    rows.find((row) => !where.status || row.status === where.status) ?? null;

describe.each([ReportEntity.Image, ReportEntity.Model])('an NSFW %s report', (type) => {
  it('is actioned with tag votes for a verified account', async () => {
    await fileNsfwReport(member, type);

    expect(existingReportLookup).not.toHaveBeenCalled();
    expect(reportCreate).toHaveBeenCalledOnce();
    expect(createdStatus()).toBe(ReportStatus.Actioned);
    expect(addTagVotes).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 41, type, id: 63, tags: ['partial nudity'], vote: 1 })
    );
  });

  it('is actioned with tag votes for an older account with no verified email', async () => {
    await fileNsfwReport(olderUnverified, type);

    expect(existingReportLookup).not.toHaveBeenCalled();
    expect(reportCreate).toHaveBeenCalledOnce();
    expect(createdStatus()).toBe(ReportStatus.Actioned);
    expect(addTagVotes).toHaveBeenCalledOnce();
  });

  it('waits for a moderator, without tag votes, for a new signup that has not verified their email', async () => {
    await fileNsfwReport(newSignup, type);

    expect(reportCreate).toHaveBeenCalledOnce();
    expect(createdStatus()).toBe(ReportStatus.Pending);
    expect(addTagVotes).not.toHaveBeenCalled();
  });

  it('folds into the open report on that entity for a new signup that has not verified their email', async () => {
    const openReport = { ...earlierReport, status: ReportStatus.Pending };
    existingReportLookup.mockImplementation(storedReports([openReport]));
    reportUpdate.mockResolvedValue({ ...openReport, alsoReportedBy: [52, 41] });

    await fileNsfwReport(newSignup, type);

    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 80 },
        data: expect.objectContaining({ alsoReportedBy: [52, 41] }),
      })
    );
    expect(addTagVotes).not.toHaveBeenCalled();
  });

  it('opens a new report, rather than joining an actioned one, for a new signup that has not verified their email', async () => {
    existingReportLookup.mockImplementation(
      storedReports([{ ...earlierReport, status: ReportStatus.Actioned }])
    );

    await fileNsfwReport(newSignup, type);

    expect(reportUpdate).not.toHaveBeenCalled();
    expect(reportCreate).toHaveBeenCalledOnce();
    expect(createdStatus()).toBe(ReportStatus.Pending);
  });
});

describe('another reason from a new signup that has not verified their email', () => {
  it('still joins an earlier report on that image, actioned or not', async () => {
    const actioned = { ...earlierReport, status: ReportStatus.Actioned };
    existingReportLookup.mockImplementation(storedReports([actioned]));
    reportUpdate.mockResolvedValue({ ...actioned, alsoReportedBy: [52, 41] });

    await createReportHandler({
      input: {
        type: ReportEntity.Image,
        id: 63,
        reason: ReportReason.TOSViolation,
        details: { violation: 'Spam' },
      },
      ctx: { user: newSignup, track: { report: vi.fn() } } as never,
    });

    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 80 } }));
  });
});

describe('an NSFW article report from a new signup that has not verified their email', () => {
  it('is actioned as before', async () => {
    await createReportHandler({
      input: { type: ReportEntity.Article, id: 63, reason: ReportReason.NSFW, details: {} },
      ctx: { user: newSignup, track: { report: vi.fn() } } as never,
    });

    expect(existingReportLookup).not.toHaveBeenCalled();
    expect(createdStatus()).toBe(ReportStatus.Actioned);
  });
});

describe('an NSFW model report', () => {
  it('casts its tag votes and touches no image', async () => {
    await fileNsfwReport(member, ReportEntity.Model);

    expect(addTagVotes).toHaveBeenCalledWith(
      expect.objectContaining({ type: ReportEntity.Model, id: 63 })
    );
    expect(dbMock.dbWrite.image.findFirst).not.toHaveBeenCalled();
    expect(ratingRequest).not.toHaveBeenCalled();
    expect(imageUpdate).not.toHaveBeenCalled();
  });
});

describe('an NSFW image report rating request', () => {
  it('is recorded for a verified account', async () => {
    await fileNsfwReport(member, ReportEntity.Image);

    expect(ratingRequest).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ imageId: 63, nsfwLevel: 4 }) })
    );
    expect(imageUpdate).toHaveBeenCalledWith({
      where: { id: 63 },
      data: { nsfwLevelLocked: false },
    });
  });

  it('is recorded for an older account with no verified email', async () => {
    await fileNsfwReport(olderUnverified, ReportEntity.Image);

    expect(ratingRequest).toHaveBeenCalledOnce();
  });

  it('is not recorded for a new signup that has not verified their email', async () => {
    await fileNsfwReport(newSignup, ReportEntity.Image);

    expect(reportCreate).toHaveBeenCalledOnce();
    expect(ratingRequest).not.toHaveBeenCalled();
    expect(imageUpdate).not.toHaveBeenCalled();
  });
});
