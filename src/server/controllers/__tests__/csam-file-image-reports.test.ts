import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CsamContextTextService from '~/server/services/csam-context-text';
import type * as CsamService from '~/server/services/csam.service';
import type * as CsamSupplementalService from '~/server/services/csam-supplemental.service';
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

const {
  bulkSetReportStatus,
  softDeleteUser,
  createCsamReport,
  snapshotCsamContextText,
  createSupplementalCsamReport,
} = vi.hoisted(() => ({
  bulkSetReportStatus: vi.fn(),
  softDeleteUser: vi.fn(async () => undefined),
  createCsamReport: vi.fn(async (..._args: unknown[]) => undefined),
  snapshotCsamContextText: vi.fn(),
  createSupplementalCsamReport: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('~/server/services/csam-supplemental.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamSupplementalService>()),
  createSupplementalCsamReport,
}));
vi.mock('~/server/services/csam.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamService>()),
  createCsamReport,
}));
vi.mock('~/server/services/csam-context-text', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamContextTextService>()),
  snapshotCsamContextText,
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

const createExternalCsamReport = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('~/server/services/csam.service-new', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createExternalCsamReport,
}));

const { createExternalCsamReportHandler, fileCsamReport } = await import(
  '~/server/controllers/csam.controller'
);

const OWNER = 20;
const OTHER_OWNER = 21;
const MOD = 2;
const IMAGE = 500;
const OTHER_IMAGE = 501;

beforeEach(() => {
  bulkSetReportStatus.mockReset().mockResolvedValue(undefined);
  softDeleteUser.mockClear();
  createCsamReport.mockClear();
  createSupplementalCsamReport.mockClear();
  snapshotCsamContextText.mockReset();
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
  it('closes the filed images’ Pending image appeals silently, before the flag comes off', async () => {
    const { releaseReviewFlagsToReportHold } = await import('~/server/services/image-appeal-flag');
    const order: string[] = [];
    dbMock.dbWrite.appeal.updateMany.mockImplementationOnce((async () => {
      order.push('close');
      return { count: 1 };
    }) as never);
    vi.mocked(releaseReviewFlagsToReportHold).mockImplementationOnce(async () => {
      order.push('release');
      return 0;
    });

    await file(OWNER, [IMAGE, OTHER_IMAGE]);

    expect(dbMock.dbWrite.appeal.updateMany).toHaveBeenCalledWith({
      where: { entityType: 'Image', entityId: { in: [IMAGE, OTHER_IMAGE] }, status: 'Pending' },
      data: expect.objectContaining({ status: 'Rejected', resolvedBy: MOD }),
    });
    expect(order).toEqual(['close', 'release']);
  });

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

describe('fileCsamReport with attached text', () => {
  const sources = { postIds: [100], commentIds: [11] };

  it('files the text copied for the images, judged against the reported account', async () => {
    const copied = [{ source: 'comment', id: 11, text: 'copied' }];
    snapshotCsamContextText.mockResolvedValueOnce(copied);

    await fileCsamReport({
      userId: OWNER,
      imageIds: [IMAGE],
      type: 'Image',
      reportedById: MOD,
      details: { minorDepiction: 'real' },
      contextSources: sources,
    });

    expect(snapshotCsamContextText).toHaveBeenCalledWith({
      imageIds: [IMAGE],
      ownerId: OWNER,
      sources,
      reportedUserIds: [OWNER],
      capturedById: MOD,
    });
    const [filed] = createCsamReport.mock.calls[0] as [Record<string, unknown>];
    expect(filed.details).toEqual({ minorDepiction: 'real', contextText: copied });
    expect(filed).not.toHaveProperty('contextSources');
  });

  it('refuses text on a report that is not an image report, filing nothing', async () => {
    await expect(
      fileCsamReport({
        userId: OWNER,
        imageIds: [],
        type: 'TrainingData',
        reportedById: MOD,
        contextSources: sources,
      })
    ).rejects.toThrow(/image report only/);
    expect(createCsamReport).not.toHaveBeenCalled();
  });

  it.each([
    ['the subject', { userId: -2 }],
    ['the secondary user', { userId: OWNER, details: { secondaryUserId: -2 } }],
  ])('refuses the feedback capture account as %s, filing nothing', async (_label, named) => {
    await expect(
      fileCsamReport({ imageIds: [], type: 'Image', reportedById: MOD, ...named } as never)
    ).rejects.toThrow(/feedback page captures/);
    expect(createCsamReport).not.toHaveBeenCalled();
  });

  it.each([
    ['the subject', { userId: -2 }],
    ['the secondary user', { userId: OWNER, secondaryUserId: -2 }],
  ])(
    'refuses the feedback capture account as %s of an external report, filing nothing',
    async (_label, named) => {
      const ctx = { user: { id: MOD } } as never;
      await expect(
        createExternalCsamReportHandler({
          input: { email: 'x@example.com', ...named } as never,
          ctx,
        })
      ).rejects.toThrow(/feedback page captures/);
      expect(createExternalCsamReport).not.toHaveBeenCalled();
      // Control: an ordinary subject is filed.
      await createExternalCsamReportHandler({
        input: { email: 'x@example.com', userId: OWNER } as never,
        ctx,
      });
      expect(createExternalCsamReport).toHaveBeenCalledTimes(1);
      createExternalCsamReport.mockClear();
    }
  );

  it('files a supplemental report with the copied text', async () => {
    const copied = [{ source: 'comment', id: 11, text: 'copied' }];
    snapshotCsamContextText.mockResolvedValueOnce(copied);

    await fileCsamReport({
      userId: OWNER,
      imageIds: [IMAGE],
      type: 'Image',
      reportedById: MOD,
      supplementalOf: 3,
      contextSources: sources,
    });

    const [filed] = createSupplementalCsamReport.mock.calls[0] as [Record<string, unknown>];
    expect(filed.details).toEqual({ contextText: copied });
    expect(filed.supplementalOf).toBe(3);
  });

  it('leaves the details as filed when no text is attached', async () => {
    await fileCsamReport({
      userId: OWNER,
      imageIds: [IMAGE],
      type: 'Image',
      reportedById: MOD,
      details: { minorDepiction: 'real' },
    });

    expect(snapshotCsamContextText).not.toHaveBeenCalled();
    const [filed] = createCsamReport.mock.calls[0] as [Record<string, unknown>];
    expect(filed.details).toEqual({ minorDepiction: 'real' });
  });

  it('files nothing and removes no account when the copy is refused', async () => {
    snapshotCsamContextText.mockRejectedValueOnce(new Error('not on the images in this report'));

    await expect(
      fileCsamReport({
        userId: OWNER,
        imageIds: [IMAGE],
        type: 'Image',
        reportedById: MOD,
        contextSources: sources,
      })
    ).rejects.toThrow('not on the images');
    expect(createCsamReport).not.toHaveBeenCalled();
    expect(softDeleteUser).not.toHaveBeenCalled();
    expect(bulkSetReportStatus).not.toHaveBeenCalled();
  });
});
