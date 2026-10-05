import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as NsfwLevels from '~/server/services/nsfwLevels.service';

vi.mock('~/server/services/nsfwLevels.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NsfwLevels>()),
  updateCollectionsNsfwLevels: vi.fn(),
}));
vi.mock('~/server/services/text-scan/notify', () => ({ notifyTextScanRatingRaised: vi.fn() }));

const { applyCollectionTextScan } = await import('~/server/services/text-scan/actions/collection');
const { updateCollectionsNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { notifyTextScanRatingRaised } = await import('~/server/services/text-scan/notify');

const args = (detectedLevel: number, raised: boolean) => ({
  entityId: 7,
  workflowId: 'wf',
  outcome: {
    nsfw: { detectedLevel, declaredLevel: 1, raised, reason: 'r' },
    triggeredLabels: [],
    nsfwLevel: detectedLevel,
  },
  subject: { fields: [], declared: { nsfwLevel: 1 } },
});

beforeEach(() => vi.clearAllMocks());

describe('applyCollectionTextScan', () => {
  it('recomputes and notifies when the bucket moved into nsfw', async () => {
    dbMock.dbWrite.collection.findUnique
      .mockResolvedValueOnce({ nsfwLevel: 1, moderatorNsfwLevel: null, userId: 9, name: 'Faves' })
      .mockResolvedValueOnce({ nsfwLevel: 29, moderatorNsfwLevel: null, userId: 9, name: 'Faves' });
    await applyCollectionTextScan(args(NsfwLevel.R, true) as never);
    expect(updateCollectionsNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Collection',
        entityId: 7,
        userId: 9,
        url: '/collections/7',
      })
    );
  });

  it('recomputes but stays silent when a moderator rated it or nothing rose', async () => {
    dbMock.dbWrite.collection.findUnique.mockResolvedValue({
      nsfwLevel: 28,
      moderatorNsfwLevel: null,
      userId: 9,
      name: 'x',
    });
    await applyCollectionTextScan(args(NsfwLevel.R, true) as never);
    dbMock.dbWrite.collection.findUnique.mockResolvedValue({
      nsfwLevel: 1,
      moderatorNsfwLevel: 1,
      userId: 9,
      name: 'x',
    });
    await applyCollectionTextScan(args(NsfwLevel.R, true) as never);
    expect(updateCollectionsNsfwLevels).toHaveBeenCalledTimes(2);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });
});
