import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSAM_CONTEXT_NO_IMAGES_REFUSAL } from '~/shared/constants/csam-context.constants';
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
  createCsamReport: vi.fn(async (..._args: unknown[]) => ({ id: 900 })),
  snapshotCsamContextText: vi.fn(),
  createSupplementalCsamReport: vi.fn(async (..._args: unknown[]) => ({ id: 901 })),
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

const { bulkAddBlockedImages } = await import('~/server/services/image.service');
const { logToAxiom } = await import('~/server/logging/client');
const {
  CSAM_BLOCKLIST_FAILED_MESSAGE,
  CSAM_HELD_MEDIA_COPY_FAILED_MESSAGE,
  createExternalCsamReportHandler,
  fileCsamReport,
} = await import('~/server/controllers/csam.controller');
const { HeldMediaCopyError } = await import('~/server/services/image.service');

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

  // The message must stop a re-file, which can create a second report. A 500's message is
  // replaced before it reaches the moderator, so this has to stay a 503 with this text.
  it('tells the moderator not to file again when the blocklist write throws, after one filing', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ pHash: BigInt(123) }] as never);
    vi.mocked(bulkAddBlockedImages).mockRejectedValueOnce(new Error('no ClickHouse client'));
    vi.mocked(logToAxiom).mockClear();

    const filing = file(OWNER, [IMAGE]);
    await expect(filing).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: CSAM_BLOCKLIST_FAILED_MESSAGE,
    });

    expect(createCsamReport).toHaveBeenCalledTimes(1);
    expect(createSupplementalCsamReport).not.toHaveBeenCalled();
    const [logged] = vi
      .mocked(logToAxiom)
      .mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.message === 'CSAM blocklist write failed');
    expect(logged.payload).toEqual({
      reportedById: MOD,
      csamReportId: 900,
      imageCount: 1,
      failedStore: 'blocklist',
    });
    expect(JSON.stringify(logged, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).not.toContain(
      '123'
    );
    expect(softDeleteUser).toHaveBeenCalledWith({ id: OWNER, userId: MOD });
    expect(bulkAddBlockedImages).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ hash: BigInt(123), reason: 'CSAM' }] })
    );
  });

  // Ruled by the moderation lead: the blocklist entry landed, so the moderator is told the copy is
  // logged for repair, with no instruction to re-block (that would mean viewing the media).
  it('names the copy as the failed store and says it is logged for repair when only the copy fails', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ pHash: BigInt(123) }] as never);
    vi.mocked(bulkAddBlockedImages).mockRejectedValueOnce(
      new HeldMediaCopyError(new Error('INSERT INTO "BlockedImage" (hash, reason) VALUES (123, …)'))
    );
    vi.mocked(logToAxiom).mockClear();

    await expect(file(OWNER, [IMAGE])).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: CSAM_HELD_MEDIA_COPY_FAILED_MESSAGE,
    });

    const [logged] = vi
      .mocked(logToAxiom)
      .mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.message === 'CSAM blocklist write failed');
    expect(logged.payload).toEqual({
      reportedById: MOD,
      csamReportId: 900,
      imageCount: 1,
      failedStore: 'held-media-copy',
    });
    expect(JSON.stringify(logged, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).not.toContain(
      '123'
    );
  });

  it('still files and removes when a filed image has no hash, logging only its id and step', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([
      { id: IMAGE, pHash: null },
      { id: OTHER_IMAGE, pHash: BigInt(123) },
    ] as never);
    vi.mocked(logToAxiom).mockClear();

    await file(OWNER, [IMAGE, OTHER_IMAGE]);

    expect(softDeleteUser).toHaveBeenCalled();
    expect(
      vi
        .mocked(logToAxiom)
        .mock.calls.map(([e]) => e as { name?: string; payload?: unknown })
        .filter((e) => e.name === 'csam-blocklist-no-hash')
        .map((e) => e.payload)
    ).toEqual([{ imageId: IMAGE, step: 'csam-report' }]);
  });

  it('leaves the blocklist write to after the removal, not to the report service', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ pHash: BigInt(123) }] as never);
    vi.mocked(logToAxiom).mockClear();

    await expect(file(OWNER, [IMAGE])).resolves.toEqual({
      denyFailed: false,
      denyBookkeepingFailed: false,
      strikesReviewFailed: false,
      contextNotAttached: [],
    });

    expect(logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'CSAM blocklist write failed' })
    );
    expect(createCsamReport).toHaveBeenCalledWith(
      expect.objectContaining({ writeBlocklist: false })
    );
    const [removedAt] = softDeleteUser.mock.invocationCallOrder;
    const writtenAt = vi.mocked(bulkAddBlockedImages).mock.invocationCallOrder.at(-1)!;
    expect(removedAt).toBeLessThan(writtenAt);
  });

  it('still writes the hashes when the account removal throws, then throws its error', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ pHash: BigInt(123) }] as never);
    vi.mocked(bulkAddBlockedImages).mockClear();
    softDeleteUser.mockRejectedValueOnce(new Error('ban failed'));

    await expect(file(OWNER, [IMAGE])).rejects.toThrow('ban failed');

    expect(bulkAddBlockedImages).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ hash: BigInt(123), reason: 'CSAM' }] })
    );
  });

  it('logs the removal failure when the blocklist write fails too', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ pHash: BigInt(123) }] as never);
    softDeleteUser.mockRejectedValueOnce(new Error('ban failed'));
    vi.mocked(bulkAddBlockedImages).mockRejectedValueOnce(new Error('no ClickHouse client'));
    vi.mocked(logToAxiom).mockClear();

    await expect(file(OWNER, [IMAGE])).rejects.toThrow('no ClickHouse client');

    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'removing the reported account failed',
        error: 'ban failed',
      })
    );
  });

  it('still closes the filed images’ appeals and deferred effects when the blocklist write throws', async () => {
    const { releaseReviewFlagsToReportHold } = await import('~/server/services/image-appeal-flag');
    vi.mocked(releaseReviewFlagsToReportHold).mockClear();
    dbMock.dbWrite.appeal.updateMany.mockClear();
    dbMock.dbWrite.$executeRaw.mockClear();
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ pHash: BigInt(123) }] as never);
    vi.mocked(bulkAddBlockedImages).mockRejectedValueOnce(new Error('no ClickHouse client'));

    await expect(file(OWNER, [IMAGE])).rejects.toThrow(CSAM_BLOCKLIST_FAILED_MESSAGE);

    expect(dbMock.dbWrite.appeal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'Rejected' }) })
    );
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(releaseReviewFlagsToReportHold).toHaveBeenCalledWith([IMAGE]);
  });
});

// A first filing of any type writes its images' hashes; a supplemental only for an Image report.
describe('fileCsamReport blocklist scope by report type', () => {
  beforeEach(() => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ pHash: BigInt(123) }] as never);
    vi.mocked(bulkAddBlockedImages).mockClear();
  });
  const fileAs = (type: string, supplementalOf?: number) =>
    fileCsamReport({
      userId: OWNER,
      imageIds: [IMAGE],
      type,
      reportedById: MOD,
      supplementalOf,
    } as never);

  it('writes no hash for a non-Image supplemental', async () => {
    await fileAs('TrainingData', 3);
    expect(bulkAddBlockedImages).toHaveBeenCalledWith(expect.objectContaining({ data: [] }));
  });

  it('writes CSAM hashes for an Image supplemental', async () => {
    await fileAs('Image', 3);
    expect(bulkAddBlockedImages).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ hash: BigInt(123), reason: 'CSAM' }] })
    );
  });

  it('writes CSAM hashes for a non-Image first filing, as main did', async () => {
    await fileAs('TrainingData');
    expect(bulkAddBlockedImages).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ hash: BigInt(123), reason: 'CSAM' }] })
    );
  });
});

describe('fileCsamReport with attached text', () => {
  const sources = {
    postIds: [100],
    commentIds: [11],
    chatMessageIds: [],
    modelIds: [],
    articleIds: [],
    serviceOfferingIds: [],
    profile: false,
  };

  it('files the text copied for the images, judged against the reported account', async () => {
    const copied = [{ source: 'comment', id: 11, text: 'copied' }];
    snapshotCsamContextText.mockResolvedValueOnce({ contextText: copied, notAttached: [] });

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

  it('files without the items that could not be attached, storing only their count and naming them back', async () => {
    const copied = [{ source: 'model', id: 701, text: 'copied' }];
    snapshotCsamContextText.mockResolvedValueOnce({
      contextText: copied,
      notAttached: ['chat message 902', 'profile'],
    });

    const result = await fileCsamReport({
      userId: OWNER,
      imageIds: [IMAGE],
      type: 'Image',
      reportedById: MOD,
      contextSources: sources,
    });

    expect(result.contextNotAttached).toEqual(['chat message 902', 'profile']);
    const [filed] = createCsamReport.mock.calls[0] as [Record<string, unknown>];
    expect(filed.details).toEqual({ contextText: copied, contextNotAttachedCount: 2 });
  });

  describe('when a step after filing throws', () => {
    const fileWithNotAttached = () => {
      snapshotCsamContextText.mockResolvedValueOnce({
        contextText: [],
        notAttached: ['chat message 902', 'profile'],
      });
      return fileCsamReport({
        userId: OWNER,
        imageIds: [IMAGE],
        type: 'Image',
        reportedById: MOD,
        contextSources: sources,
      });
    };
    const named = /Not attached: chat message 902, profile\./;

    it('names what was not attached and says not to file again', async () => {
      softDeleteUser.mockRejectedValueOnce(new Error('ban failed'));
      const removal = await fileWithNotAttached().catch((e: Error) => e);
      expect((removal as Error).message).toMatch(
        /^The report was filed\..*Do not file the report again\./
      );
      expect((removal as Error).message).toMatch(named);

      vi.mocked(dbMock.dbWrite.appeal.updateMany).mockRejectedValueOnce(new Error('db down'));
      await expect(fileWithNotAttached()).rejects.toThrow(named);
    });

    it('keeps the blocklist message, adding the names', async () => {
      vi.mocked(bulkAddBlockedImages).mockRejectedValueOnce(new Error('no ClickHouse client'));
      const error = (await fileWithNotAttached().catch((e: Error) => e)) as Error;
      expect(error.message.startsWith(CSAM_BLOCKLIST_FAILED_MESSAGE)).toBe(true);
      expect(error.message).toMatch(named);
    });
  });

  it('refuses text on an image report with no images, before filing anything', async () => {
    await expect(
      fileCsamReport({
        userId: OWNER,
        imageIds: [],
        type: 'Image',
        reportedById: MOD,
        contextSources: { ...sources, postIds: [], commentIds: [], profile: true },
      })
    ).rejects.toThrow(CSAM_CONTEXT_NO_IMAGES_REFUSAL);
    expect(snapshotCsamContextText).not.toHaveBeenCalled();
    expect(createCsamReport).not.toHaveBeenCalled();
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
    snapshotCsamContextText.mockResolvedValueOnce({ contextText: copied, notAttached: [] });

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
