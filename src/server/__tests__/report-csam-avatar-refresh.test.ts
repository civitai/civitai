import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { refreshProfilePicturesForImages } = vi.hoisted(() => ({
  refreshProfilePicturesForImages: vi.fn(async () => undefined),
}));
// A plain factory, not importOriginal: loading the real user.service pulls in most of the server,
// which fails under the partial db mock; the never-throwing lazy import would then swallow that
// and the refresh would never be called.
vi.mock('~/server/services/user.service', () => ({ refreshProfilePicturesForImages }));
vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const reportCreate = vi.fn();
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ report: { create: (...args: unknown[]) => reportCreate(...args) } })
);

const { imagesSearchIndex, imagesMetricsSearchIndex } = await import('~/server/search-index');
const { createReport } = await import('~/server/services/report.service');

const IMAGE_ID = 1234;

const reportCsam = () =>
  createReport({
    userId: 7,
    id: IMAGE_ID,
    type: ReportEntity.Image,
    reason: ReportReason.CSAM,
    isModerator: true,
    details: {},
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  dbMock.dbWrite.report.findFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
});

describe('a CSAM image report', () => {
  // The block is written through dbWrite (autocommitted, not the report's tx), so it stands even
  // when a later step throws. The avatar cache has to be refreshed whenever the block landed.
  it.each([
    ['images', () => imagesSearchIndex],
    ['image metrics', () => imagesMetricsSearchIndex],
  ])(
    'refreshes the blocked image owner avatars even when the %s search-index queue throws',
    async (_name, index) => {
      vi.spyOn(imagesSearchIndex, 'queueUpdate').mockResolvedValue(undefined as never);
      vi.spyOn(imagesMetricsSearchIndex, 'queueUpdate').mockResolvedValue(undefined as never);
      vi.spyOn(index(), 'queueUpdate').mockRejectedValue(new Error('queue down'));

      await expect(reportCsam()).rejects.toThrow('queue down');

      expect(dbMock.dbWrite.image.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: IMAGE_ID } })
      );
      expect(refreshProfilePicturesForImages).toHaveBeenCalledWith([IMAGE_ID]);
    }
  );

  it('refreshes the avatars once when every step succeeds', async () => {
    vi.spyOn(imagesSearchIndex, 'queueUpdate').mockResolvedValue(undefined as never);
    vi.spyOn(imagesMetricsSearchIndex, 'queueUpdate').mockResolvedValue(undefined as never);

    await reportCsam();

    expect(refreshProfilePicturesForImages).toHaveBeenCalledTimes(1);
    expect(refreshProfilePicturesForImages).toHaveBeenCalledWith([IMAGE_ID]);
  });
});
