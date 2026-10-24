import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SearchIndex from '~/server/search-index';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
}));

const { setCollectionItemNsfwLevel } = await import('~/server/services/collection.service');
const { imagesSearchIndex } = await import('~/server/search-index');

const COLLECTION_ID = 10;
const ITEM_ID = 20;
const IMAGE_ID = 55;

function arrange(updatedCount: number) {
  mockDbRead.collectionItem.findUniqueOrThrow.mockResolvedValue({
    id: ITEM_ID,
    imageId: IMAGE_ID,
    collectionId: COLLECTION_ID,
    collection: { type: 'Image', metadata: { judgesApplyBrowsingLevel: true } },
  } as never);
  mockDbRead.image.findUnique.mockResolvedValue({
    post: { collectionId: COLLECTION_ID },
  } as never);
  mockDbWrite.image.updateMany.mockResolvedValue({ count: updatedCount } as never);
}

const rate = () => setCollectionItemNsfwLevel({ collectionItemId: ITEM_ID, nsfwLevel: 4 });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('setCollectionItemNsfwLevel and blocked images', () => {
  it('writes only to an image that is not Blocked, in the same statement', async () => {
    arrange(1);

    await rate();

    expect(mockDbWrite.image.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.image.updateMany.mock.calls[0][0]?.where).toEqual({
      id: IMAGE_ID,
      ingestion: { not: ImageIngestionStatus.Blocked },
    });
    expect(mockDbWrite.image.update).not.toHaveBeenCalled();
  });

  it('marks the image Scanned and clears any stale blockedFor', async () => {
    arrange(1);

    await rate();

    expect(mockDbWrite.image.updateMany.mock.calls[0][0]?.data).toMatchObject({
      nsfwLevel: 4,
      ingestion: ImageIngestionStatus.Scanned,
      blockedFor: null,
    });
    expect(imagesSearchIndex.queueUpdate).toHaveBeenCalledTimes(1);
  });

  it('refuses when the image is Blocked, and queues no index update', async () => {
    arrange(0);

    await expect(rate()).rejects.toThrow(/blocked/i);
    expect(imagesSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });
});
