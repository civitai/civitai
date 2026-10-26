import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TagService from '~/server/services/tag.service';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';
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
  // The reported tag rates above the image, so the rating-request leg has work to do.
  getModeratedTags.mockResolvedValue([{ name: 'partial nudity', nsfwLevel: 4 }]);
  dbMock.dbWrite.image.findFirst.mockResolvedValue({ nsfwLevel: 1, nsfwLevelLocked: true });
});

const ratingRequest = dbMock.dbWrite.imageRatingRequest.upsert;
const imageUpdate = dbMock.dbWrite.image.update;

describe.each([ReportEntity.Image, ReportEntity.Model])('an NSFW %s report', (type) => {
  it('records the tag votes and rating request for a verified account', async () => {
    await fileNsfwReport(member, type);

    expect(reportCreate).toHaveBeenCalledOnce();
    expect(addTagVotes).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 41, type, id: 63, tags: ['partial nudity'], vote: 1 })
    );
    expect(ratingRequest).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ imageId: 63, nsfwLevel: 4 }) })
    );
    expect(imageUpdate).toHaveBeenCalledWith({
      where: { id: 63 },
      data: { nsfwLevelLocked: false },
    });
  });

  it('records the tag votes and rating request for an older account with no verified email', async () => {
    await fileNsfwReport(olderUnverified, type);

    expect(reportCreate).toHaveBeenCalledOnce();
    expect(addTagVotes).toHaveBeenCalledOnce();
    expect(ratingRequest).toHaveBeenCalledOnce();
  });

  it('is filed without tag votes or a rating request for a new signup that has not verified their email', async () => {
    await fileNsfwReport(newSignup, type);

    expect(reportCreate).toHaveBeenCalledOnce();
    expect(addTagVotes).not.toHaveBeenCalled();
    expect(ratingRequest).not.toHaveBeenCalled();
    expect(imageUpdate).not.toHaveBeenCalled();
  });
});
