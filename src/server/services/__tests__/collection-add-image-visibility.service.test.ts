import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as SearchIndex from '~/server/search-index';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// Adding an image to a collection refuses an image the caller couldn't open, before anything is
// written or followed. The visibility rule itself is covered in
// image-ids-visible-to-viewer.behavior.test.ts; here it answers "hidden" for HIDDEN_IMAGE only.

const HIDDEN_IMAGE = 66;
const VISIBLE_IMAGE = 42;

const { assertVisible } = vi.hoisted(() => ({
  assertVisible: vi.fn(async ({ ids }: { ids: number[] }) => {
    if (ids.includes(66)) throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
  }),
}));
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageVisibility>()),
  assertImagesVisibleToViewer: assertVisible,
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  homeBlockCacheBust: vi.fn(),
}));

const { saveItemInCollections, bulkSaveItems } = await import(
  '~/server/services/collection.service'
);

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const SUBMITTER_ID = 555;

const collectionRow = {
  id: COLLECTION_ID,
  name: 'Someone else’s collection',
  description: null,
  read: 'Public',
  write: 'Public',
  type: 'Image',
  nsfw: false,
  nsfwLevel: 0,
  image: null,
  mode: null,
  metadata: {},
  availability: 'Public',
  userId: OWNER_ID,
  tags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.collection.findMany.mockResolvedValue([collectionRow]);
  mockDbRead.collection.findUnique.mockResolvedValue(collectionRow);
  mockDbRead.collectionItem.findMany.mockResolvedValue([]);
  mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
  mockDbRead.challengeJudge.findMany.mockResolvedValue([]);
  // getUserCollectionPermissionsByIds: a Public-write collection the submitter doesn't follow yet.
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Public',
      userId: OWNER_ID,
      type: 'Image',
      mode: null,
      contributorPermissions: null,
      collaborationDisabledAt: null,
    },
  ]);
  mockDbWrite.$executeRaw.mockReturnValue('insert' as never);
  mockDbWrite.$transaction.mockResolvedValue([]);
  mockDbWrite.collectionItem.createMany.mockResolvedValue({ count: 1 });
});

const save = (input: Record<string, unknown>) =>
  saveItemInCollections({
    input: { type: 'Image', userId: SUBMITTER_ID, removeFromCollectionIds: [], ...input } as never,
  });

describe('saveItemInCollections with an image', () => {
  it('refuses an image the caller cannot open, and writes and follows nothing', async () => {
    await expect(
      save({ imageId: HIDDEN_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionContributor.upsert).not.toHaveBeenCalled();
  });

  it('adds an image the caller can open', async () => {
    await expect(
      save({ imageId: VISIBLE_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).resolves.toBe('added');
    expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it('still removes an image that has since become hidden', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: null, addedById: SUBMITTER_ID, note: null },
    ]);
    mockDbWrite.collectionItem.deleteMany.mockReturnValue('delete' as never);

    await expect(
      save({ imageId: HIDDEN_IMAGE, collections: [], removeFromCollectionIds: [COLLECTION_ID] })
    ).resolves.toBeDefined();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalled();
  });

  it('does not fail a re-save of membership the image already has', async () => {
    // Callers send the item's whole membership; an unchanged entry writes nothing new.
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: null, addedById: SUBMITTER_ID, note: null },
    ]);

    await expect(
      save({ imageId: HIDDEN_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).resolves.toBeDefined();
  });

  it('leaves non-image items alone', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([{ ...collectionRow, type: 'Model' }]);
    mockDbRead.model.findMany.mockResolvedValue([{ id: HIDDEN_IMAGE, userId: SUBMITTER_ID }]);

    await save({
      modelId: HIDDEN_IMAGE,
      type: 'Model',
      collections: [{ collectionId: COLLECTION_ID }],
    });
    expect(assertVisible).not.toHaveBeenCalled();
  });
});

const bulk = (imageIds: number[]) =>
  bulkSaveItems({
    input: { collectionId: COLLECTION_ID, imageIds, userId: SUBMITTER_ID } as never,
    permissions: {
      collectionId: COLLECTION_ID,
      read: true,
      write: true,
      writeReview: false,
      manage: false,
      follow: true,
      isContributor: false,
      isOwner: false,
      isCollaborator: false,
    } as never,
  });

describe('bulkSaveItems with images', () => {
  it('refuses the batch when any image is one the caller cannot open, before following', async () => {
    await expect(bulk([VISIBLE_IMAGE, HIDDEN_IMAGE])).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockDbWrite.collectionItem.createMany).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionContributor.upsert).not.toHaveBeenCalled();
  });

  it('adds images the caller can open', async () => {
    await expect(bulk([VISIBLE_IMAGE])).resolves.toMatchObject({ imageIds: [VISIBLE_IMAGE] });
  });
});
