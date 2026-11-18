import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ItemVisibility from '~/server/services/collection-item-visibility';
import type * as SearchIndex from '~/server/search-index';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// Posts, articles and models are refused on every add path when the caller couldn't see them.
// The per-type rule is covered in collection-item-visibility.behavior.test.ts; here id 66 is
// hidden whatever its type.

const HIDDEN = 66;

// Hidden only under the key the test names, so a list checked under the wrong type passes.
const { assertVisible, hiddenKey } = vi.hoisted(() => ({
  hiddenKey: { value: '' },
  assertVisible: vi.fn(async ({ itemKey, ids }: { itemKey: string; ids: number[] }) => {
    if (itemKey === hiddenKey.value && ids.includes(66))
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found' });
  }),
}));
vi.mock('~/server/services/collection-item-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof ItemVisibility>()),
  assertCollectionItemsVisibleToViewer: assertVisible,
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

const { saveItemInCollections, bulkSaveItems, upsertCollection } = await import(
  '~/server/services/collection.service'
);

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const SUBMITTER_ID = 555;

const collectionRow = (type: string) => ({
  id: COLLECTION_ID,
  name: 'Someone else’s collection',
  description: null,
  read: 'Public',
  write: 'Public',
  type,
  nsfw: false,
  nsfwLevel: 0,
  image: null,
  mode: null,
  metadata: {},
  availability: 'Public',
  userId: OWNER_ID,
  tags: [],
});

const TYPES = [
  ['Image', 'imageId', 'imageIds'],
  ['Post', 'postId', 'postIds'],
  ['Article', 'articleId', 'articleIds'],
  ['Model', 'modelId', 'modelIds'],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  hiddenKey.value = '';
  mockDbRead.collectionItem.findMany.mockResolvedValue([]);
  mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
  mockDbRead.challengeJudge.findMany.mockResolvedValue([]);
  mockDbWrite.$executeRaw.mockReturnValue('insert' as never);
  mockDbWrite.$transaction.mockResolvedValue([]);
});

const arrange = (type: string) => {
  mockDbRead.collection.findMany.mockResolvedValue([collectionRow(type)]);
  mockDbRead.collection.findUnique.mockResolvedValue(collectionRow(type));
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Public',
      userId: OWNER_ID,
      type,
      mode: null,
      contributorPermissions: null,
      collaborationDisabledAt: null,
    },
  ]);
};

describe.each(TYPES)('adding a %s', (type, key, bulkKey) => {
  beforeEach(() => {
    hiddenKey.value = key;
  });

  it('refuses one the caller cannot see, through saveItemInCollections', async () => {
    arrange(type);
    await expect(
      saveItemInCollections({
        input: {
          type,
          [key]: HIDDEN,
          userId: SUBMITTER_ID,
          collections: [{ collectionId: COLLECTION_ID }],
          removeFromCollectionIds: [],
        } as never,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
    expect(assertVisible).toHaveBeenCalledTimes(1);
  });

  it('adds one the caller can see, through saveItemInCollections', async () => {
    arrange(type);
    await expect(
      saveItemInCollections({
        input: {
          type,
          [key]: 5,
          userId: SUBMITTER_ID,
          collections: [{ collectionId: COLLECTION_ID }],
          removeFromCollectionIds: [],
        } as never,
      })
    ).resolves.toBe('added');
  });

  it('refuses one the caller cannot see, through bulkSaveItems', async () => {
    arrange(type);
    await expect(
      bulkSaveItems({
        input: { collectionId: COLLECTION_ID, [bulkKey]: [HIDDEN], userId: SUBMITTER_ID } as never,
        permissions: { write: true, isContributor: true, isOwner: false } as never,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDbWrite.collectionItem.createMany).not.toHaveBeenCalled();
    expect(assertVisible).toHaveBeenCalledWith(expect.objectContaining({ itemKey: key }));
  });

  it('refuses one the caller cannot see as the first item of a new collection', async () => {
    await expect(
      upsertCollection({
        input: { name: 'Mine', type, read: 'Public', [key]: HIDDEN, userId: SUBMITTER_ID },
      } as never)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDbWrite.collection.create).not.toHaveBeenCalled();
  });
});

it('refuses a hidden 3D model as the first item of a new collection', async () => {
  hiddenKey.value = 'model3dId';
  await expect(
    upsertCollection({
      input: { name: 'Mine', type: 'Model3D', read: 'Public', model3dId: HIDDEN, userId: 1 },
    } as never)
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(mockDbWrite.collection.create).not.toHaveBeenCalled();
});

it('passes the item type and the caller to the check', async () => {
  arrange('Article');
  await saveItemInCollections({
    input: {
      type: 'Article',
      articleId: 5,
      userId: SUBMITTER_ID,
      isModerator: true,
      collections: [{ collectionId: COLLECTION_ID }],
      removeFromCollectionIds: [],
    } as never,
  }).catch(() => undefined);
  expect(assertVisible).toHaveBeenCalledWith({
    itemKey: 'articleId',
    ids: [5],
    userId: SUBMITTER_ID,
    isModerator: true,
  });
});

it('judges the item that was sent, when other item fields arrive empty', async () => {
  hiddenKey.value = 'postId';
  arrange('Post');
  await expect(
    saveItemInCollections({
      input: {
        type: 'Post',
        imageId: undefined,
        modelId: undefined,
        articleId: undefined,
        postId: HIDDEN,
        userId: SUBMITTER_ID,
        collections: [{ collectionId: COLLECTION_ID }],
        removeFromCollectionIds: [],
      } as never,
    })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
});

it('does not check an item already in the collection that writes nothing new', async () => {
  hiddenKey.value = 'postId';
  arrange('Post');
  mockDbRead.collectionItem.findMany.mockResolvedValue([
    { id: 7, collectionId: COLLECTION_ID, tagId: null, addedById: SUBMITTER_ID, note: null },
  ]);
  await expect(
    saveItemInCollections({
      input: {
        type: 'Post',
        postId: HIDDEN,
        userId: SUBMITTER_ID,
        collections: [{ collectionId: COLLECTION_ID }],
        removeFromCollectionIds: [],
      } as never,
    })
  ).resolves.toBeDefined();
  expect(assertVisible).not.toHaveBeenCalled();
});
