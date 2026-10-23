import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CsamService from '~/server/services/csam.service';
import type * as ImageAppealFlag from '~/server/services/image-appeal-flag';
import type * as ImageService from '~/server/services/image.service';
import type * as ReportService from '~/server/services/report.service';
import type * as UserService from '~/server/services/user.service';

/**
 * Filing a CSAM report on images actions the reports made about those images. Ids below are
 * invented; an image id and a report id are deliberately equal, so passing the wrong one shows.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { bulkSetReportStatus, softDeleteUser } = vi.hoisted(() => ({
  bulkSetReportStatus: vi.fn(),
  softDeleteUser: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/csam.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamService>()),
  createCsamReport: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  softDeleteUser,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  bulkAddBlockedImages: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/image-appeal-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageAppealFlag>()),
  releaseReviewFlagsToReportHold: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  bulkSetReportStatus,
}));

const { fileCsamReport } = await import('~/server/controllers/csam.controller');

const OWNER = 20;
const OTHER_OWNER = 21;
const MOD = 2;
const IMAGE = 500;
const OTHER_IMAGE = 501;

beforeEach(() => {
  bulkSetReportStatus.mockReset().mockResolvedValue(undefined);
  softDeleteUser.mockClear();
  dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.imageReport.findMany.mockImplementation((async ({
    where,
  }: {
    where: { imageId: { in: number[] } };
  }) =>
    [
      { imageId: IMAGE, reportId: 7, image: { userId: OWNER } },
      { imageId: IMAGE, reportId: 8, image: { userId: OWNER } },
      { imageId: OTHER_IMAGE, reportId: IMAGE, image: { userId: OTHER_OWNER } },
    ].filter((row) => where.imageId.in.includes(row.imageId))) as never);
});

const file = (userId: number, imageIds: number[]) =>
  fileCsamReport({ userId, imageIds, type: 'Image', reportedById: MOD } as never);

describe('fileCsamReport', () => {
  it('actions the reports made about the filed images, never a report whose id is an image id', async () => {
    await file(OWNER, [IMAGE]);

    expect(bulkSetReportStatus).toHaveBeenCalledTimes(1);
    expect(bulkSetReportStatus.mock.calls[0][0]).toMatchObject({
      ids: [7, 8],
      status: 'Actioned',
      userId: MOD,
      rewardRemovedReporters: false,
    });
  });

  it('rewards neither the reported account nor the owners of the filed images', async () => {
    await file(-1, [IMAGE, OTHER_IMAGE]);

    const { ids, noRewardFor } = bulkSetReportStatus.mock.calls[0][0];
    expect(ids).toEqual([7, 8, IMAGE]);
    expect(noRewardFor(7)).toEqual([-1, OWNER]);
    expect(noRewardFor(IMAGE)).toEqual([-1, OTHER_OWNER]);
  });

  it('still removes the account when actioning the reports fails', async () => {
    bulkSetReportStatus.mockRejectedValueOnce(new Error('connection lost'));

    await file(OWNER, [IMAGE]);

    expect(softDeleteUser).toHaveBeenCalledWith({ id: OWNER, userId: MOD });
  });
});
