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

// Reset, not clear: a test that returns before the second read leaves a queued value behind.
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.collection.findUnique.mockReset();
});

describe('applyCollectionTextScan', () => {
  it('recomputes and notifies when the bucket moved into nsfw', async () => {
    dbMock.dbWrite.collection.findUnique
      .mockResolvedValueOnce({ nsfwLevel: 1, moderatorNsfwLevel: null, userId: 9, name: 'Faves' })
      .mockResolvedValueOnce({ nsfwLevel: 29, moderatorNsfwLevel: null, userId: 9, name: 'Faves' });
    await applyCollectionTextScan(args(NsfwLevel.R, true) as never);
    expect(updateCollectionsNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).toHaveBeenCalledTimes(1);
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Collection',
        entityId: 7,
        userId: 9,
        url: '/collections/7',
      })
    );
  });

  it('recomputes but stays silent when a moderator rated it, even if the bucket rose', async () => {
    dbMock.dbWrite.collection.findUnique
      .mockResolvedValueOnce({ nsfwLevel: 1, moderatorNsfwLevel: 1, userId: 9, name: 'x' })
      .mockResolvedValueOnce({ nsfwLevel: 29, moderatorNsfwLevel: 1, userId: 9, name: 'x' });
    await applyCollectionTextScan(args(NsfwLevel.R, true) as never);
    expect(updateCollectionsNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it('recomputes but stays silent when the bucket was already nsfw', async () => {
    dbMock.dbWrite.collection.findUnique.mockResolvedValue({
      nsfwLevel: 28,
      moderatorNsfwLevel: null,
      userId: 9,
      name: 'x',
    });
    await applyCollectionTextScan(args(NsfwLevel.R, true) as never);
    expect(updateCollectionsNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it('does nothing without an nsfw outcome', async () => {
    await applyCollectionTextScan({
      ...args(NsfwLevel.R, true),
      outcome: { triggeredLabels: [], nsfwLevel: 1 },
    } as never);
    expect(dbMock.dbWrite.collection.findUnique).not.toHaveBeenCalled();
    expect(updateCollectionsNsfwLevels).not.toHaveBeenCalled();
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it('recomputes without a notice when the text did not raise the rating', async () => {
    dbMock.dbWrite.collection.findUnique
      .mockResolvedValueOnce({ nsfwLevel: 1, moderatorNsfwLevel: null, userId: 9, name: 'x' })
      .mockResolvedValueOnce({ nsfwLevel: 29, moderatorNsfwLevel: null, userId: 9, name: 'x' });
    await applyCollectionTextScan(args(NsfwLevel.R, false) as never);
    expect(updateCollectionsNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it('does not credit a PG13 raise with a bucket that rose from items', async () => {
    dbMock.dbWrite.collection.findUnique
      .mockResolvedValueOnce({ nsfwLevel: 1, moderatorNsfwLevel: null, userId: 9, name: 'x' })
      .mockResolvedValueOnce({ nsfwLevel: 29, moderatorNsfwLevel: null, userId: 9, name: 'x' });
    await applyCollectionTextScan(args(NsfwLevel.PG13, true) as never);
    expect(updateCollectionsNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });
});
