import { describe, expect, it, beforeEach, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const { updateCollectionCoverImage } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const OUTSIDER_ID = 12_345;
const IMAGE_ID = 55;

// `getUserCollectionPermissionsByIds` reads the collection row through `$queryRaw`; `manage` is
// derived from it, so the row is the only input that decides authorization here.
function arrangeCollection({
  contributorPermissions = null,
}: { contributorPermissions?: string[] | null } = {}) {
  mockDbRead.$queryRaw.mockReset();
  mockDbWrite.collection.update.mockReset();
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Private',
      userId: OWNER_ID,
      type: 'Image',
      mode: null,
      contributorPermissions,
    },
  ]);
  mockDbWrite.collection.update.mockResolvedValue({
    id: COLLECTION_ID,
    image: { id: IMAGE_ID, url: 'abc', ingestion: 'Scanned', type: 'image' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateCollectionCoverImage authorization', () => {
  // The regression: this used to `return` instead of throwing, so tRPC resolved cleanly and the
  // client's `onSuccess` reported "Cover image updated" for a write the server had just refused.
  it('rejects a viewer without manage instead of resolving silently', async () => {
    arrangeCollection();

    await expect(
      updateCollectionCoverImage({
        input: { id: COLLECTION_ID, imageId: IMAGE_ID, userId: OUTSIDER_ID },
      })
    ).rejects.toThrowError(/permission/i);

    expect(mockDbWrite.collection.update).not.toHaveBeenCalled();
  });

  it('updates the cover for a user who holds manage', async () => {
    arrangeCollection();

    const result = await updateCollectionCoverImage({
      input: { id: COLLECTION_ID, imageId: IMAGE_ID, userId: OWNER_ID },
    });

    expect(result).toMatchObject({ id: COLLECTION_ID });
    expect(mockDbWrite.collection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: COLLECTION_ID },
        data: { image: { connect: { id: IMAGE_ID } } },
      })
    );
  });
});
