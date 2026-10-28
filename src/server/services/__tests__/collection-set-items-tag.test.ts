import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';

const mockDbWrite = dbMock.dbWrite;

const { mockHomeBlockCacheBust } = vi.hoisted(() => ({ mockHomeBlockCacheBust: vi.fn() }));
vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  homeBlockCacheBust: mockHomeBlockCacheBust,
}));

const { setCollectionItemsTag } = await import('~/server/services/collection.service');

const CONTEST = 100;
const OTHER = 200;
const CONCEPT_TAG = 195;
const OTHER_COLLECTION_TAG = 300;

// CollectionItem rows; findMany filters them by its where clause, so membership is decided by data.
const rows = [
  { id: 1, collectionId: CONTEST, imageId: 11, modelId: null },
  { id: 2, collectionId: CONTEST, imageId: 12, modelId: null },
  { id: 3, collectionId: OTHER, imageId: 13, modelId: null },
  { id: 4, collectionId: CONTEST, imageId: null, modelId: 14 },
];

beforeEach(() => {
  vi.resetAllMocks();
  mockDbWrite.collection.findUnique.mockImplementation((({ where }: { where: { id: number } }) =>
    Promise.resolve(
      where.id === CONTEST
        ? { id: CONTEST, tags: [{ tagId: CONCEPT_TAG }] }
        : where.id === OTHER
        ? { id: OTHER, tags: [{ tagId: OTHER_COLLECTION_TAG }] }
        : null
    )) as never);
  mockDbWrite.collectionItem.findMany.mockImplementation((({
    where,
  }: {
    where: Record<string, unknown>;
  }) => {
    const { collectionId, ...rest } = where;
    const [column, filter] = Object.entries(rest)[0] as [string, { in: number[] }];
    return Promise.resolve(
      rows.filter(
        (r) =>
          r.collectionId === collectionId &&
          filter.in.includes((r as Record<string, unknown>)[column] as number)
      )
    );
  }) as never);
  mockDbWrite.collectionItem.updateMany.mockImplementation((({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => Promise.resolve({ count: where.id.in.length })) as never);
});

describe('setCollectionItemsTag', () => {
  it('writes the tag to only the requested entries, scoped to the collection', async () => {
    const result = await setCollectionItemsTag({
      collectionId: CONTEST,
      items: { type: 'collectionItem', ids: [1, 2] },
      tagId: CONCEPT_TAG,
    });

    expect(result).toEqual({ count: 2, collectionItemIds: [1, 2] });
    expect(mockDbWrite.collectionItem.updateMany).toHaveBeenCalledWith({
      where: { collectionId: CONTEST, id: { in: [1, 2] } },
      data: { tagId: CONCEPT_TAG },
    });
    expect(mockHomeBlockCacheBust).toHaveBeenCalledWith('Collection', CONTEST);
  });

  it('resolves entries by their image id', async () => {
    const result = await setCollectionItemsTag({
      collectionId: CONTEST,
      items: { type: 'image', ids: [12] },
      tagId: CONCEPT_TAG,
    });

    expect(result.collectionItemIds).toEqual([2]);
  });

  it('refuses an item from another collection and writes nothing', async () => {
    await expect(
      setCollectionItemsTag({
        collectionId: CONTEST,
        items: { type: 'collectionItem', ids: [1, 3] },
        tagId: CONCEPT_TAG,
      })
    ).rejects.toThrow(/Not in collection 100 \(collectionItem\): 3$/);
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('does not match an image id against a model entry', async () => {
    await expect(
      setCollectionItemsTag({
        collectionId: CONTEST,
        items: { type: 'image', ids: [14] },
        tagId: CONCEPT_TAG,
      })
    ).rejects.toThrow(/: 14$/);
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a tag that belongs to another collection, and writes nothing', async () => {
    await expect(
      setCollectionItemsTag({
        collectionId: CONTEST,
        items: { type: 'collectionItem', ids: [1] },
        tagId: OTHER_COLLECTION_TAG,
      })
    ).rejects.toThrow(`Tag ${OTHER_COLLECTION_TAG} is not one of this collection's tags`);
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('clears the tag with null', async () => {
    await setCollectionItemsTag({
      collectionId: CONTEST,
      items: { type: 'collectionItem', ids: [1] },
      tagId: null,
    });

    expect(mockDbWrite.collectionItem.updateMany).toHaveBeenCalledWith({
      where: { collectionId: CONTEST, id: { in: [1] } },
      data: { tagId: null },
    });
  });

  it('404s an unknown collection', async () => {
    await expect(
      setCollectionItemsTag({
        collectionId: 999,
        items: { type: 'collectionItem', ids: [1] },
        tagId: null,
      })
    ).rejects.toThrow('No collection with id 999');
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });
});
