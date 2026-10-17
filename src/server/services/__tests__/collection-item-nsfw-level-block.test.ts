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

const COLLECTION_ID = 10;
const ITEM_ID = 20;
const IMAGE_ID = 55;

function arrange(ingestion: ImageIngestionStatus) {
  mockDbRead.collectionItem.findUniqueOrThrow.mockResolvedValue({
    id: ITEM_ID,
    imageId: IMAGE_ID,
    collectionId: COLLECTION_ID,
    collection: { type: 'Image', metadata: { judgesApplyBrowsingLevel: true } },
  } as never);
  mockDbRead.image.findUnique.mockResolvedValue({
    ingestion,
    post: { collectionId: COLLECTION_ID },
  } as never);
  mockDbWrite.image.update.mockResolvedValue({} as never);
}

const writtenData = () =>
  (mockDbWrite.image.update.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined)
    ?.data;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('setCollectionItemNsfwLevel and blocked images', () => {
  it('marks a pending image Scanned and clears any stale blockedFor', async () => {
    arrange(ImageIngestionStatus.Pending);

    await setCollectionItemNsfwLevel({ collectionItemId: ITEM_ID, nsfwLevel: 4 });

    expect(mockDbWrite.image.update).toHaveBeenCalledTimes(1);
    expect(writtenData()).toMatchObject({
      nsfwLevel: 4,
      ingestion: ImageIngestionStatus.Scanned,
      blockedFor: null,
    });
  });

  it('writes only the rating on a Blocked image, leaving its block in place', async () => {
    arrange(ImageIngestionStatus.Blocked);

    await setCollectionItemNsfwLevel({ collectionItemId: ITEM_ID, nsfwLevel: 4 });

    expect(mockDbWrite.image.update).toHaveBeenCalledTimes(1);
    expect(writtenData()).toEqual({ nsfwLevel: 4 });
  });
});
