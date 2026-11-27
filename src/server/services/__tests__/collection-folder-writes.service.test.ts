import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The folder guard as the collection write paths run it: adding, bulk-adding and removing items
 * refuse a folder write the guard refuses, before anything is written. The guard's own rules are
 * covered in profile-folders.service.test.ts; this pins that each write path calls it. Ids are
 * invented.
 */

const { saveItemInCollections, bulkSaveItems, removeCollectionItem } = await import(
  '~/server/services/collection.service'
);

const OWNER = 5;
const FOLDER = 10;
const STRANGERS_IMAGE = 77;

const folder = {
  id: FOLDER,
  userId: OWNER,
  mode: 'Folder',
  type: null,
  read: 'Public',
  write: 'Private',
  name: 'f',
  description: null,
  nsfw: false,
  metadata: {},
  availability: 'Unsearchable',
};
const access = { foldersEnabled: true, session: { muted: false, mutedAt: null } };
const flagOff = { foldersEnabled: false, session: { muted: false, mutedAt: null } };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.collection.findMany.mockResolvedValue([folder] as never);
  dbMock.dbRead.collection.findUnique.mockResolvedValue(folder as never);
  // The image belongs to someone else: the owner-content check finds none of the owner's.
  dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
});

const wroteNothing = () => {
  expect(dbMock.dbWrite.collectionItem.createMany).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
};

describe('folder writes through the collection write paths', () => {
  it("refuses saving someone else's image into a folder", async () => {
    await expect(
      saveItemInCollections({
        input: {
          userId: OWNER,
          type: 'Image',
          imageId: STRANGERS_IMAGE,
          collections: [{ collectionId: FOLDER }],
          folderAccess: access,
        } as never,
      })
    ).rejects.toThrow(/owner's own content/);
    wroteNothing();
  });

  it("refuses bulk-adding someone else's image into a folder", async () => {
    await expect(
      bulkSaveItems({
        input: {
          userId: OWNER,
          collectionId: FOLDER,
          imageIds: [STRANGERS_IMAGE],
          folderAccess: access,
        } as never,
        permissions: { manage: true, write: true } as never,
      })
    ).rejects.toThrow(/owner's own content/);
    wroteNothing();
  });

  it('refuses removing from a folder without the folders flag', async () => {
    await expect(
      removeCollectionItem({
        userId: OWNER,
        collectionId: FOLDER,
        itemId: 1,
        type: 'Image',
        folderAccess: flagOff,
        permissions: { collectionMode: 'Folder', collectionType: null, manage: true } as never,
      })
    ).rejects.toThrow(/not available/);
    wroteNothing();
  });
});
