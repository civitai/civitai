import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
const JUDGED_TAG = 196;
const OTHER_COLLECTION_TAG = 300;
// Written to entries by the paid-review flow but never added to the collection's tags.
const REVIEW_REQUEST_TAG = 400;
// Distinct from any id count, so a service that reports its own tally instead of the write's fails.
const WRITE_COUNT = 7;

const entry = { imageId: null, modelId: null, postId: null, articleId: null, tagId: null };
// CollectionItem rows; findMany filters them by its where clause, so membership is decided by data.
const rows = [
  { ...entry, id: 1, collectionId: CONTEST, imageId: 11 },
  { ...entry, id: 2, collectionId: CONTEST, imageId: 12 },
  { ...entry, id: 3, collectionId: OTHER, imageId: 13 },
  { ...entry, id: 4, collectionId: CONTEST, modelId: 14 },
  { ...entry, id: 5, collectionId: CONTEST, postId: 15 },
  { ...entry, id: 6, collectionId: CONTEST, articleId: 16 },
  { ...entry, id: 8, collectionId: CONTEST, imageId: 18, tagId: JUDGED_TAG },
  { ...entry, id: 9, collectionId: CONTEST, imageId: 19, tagId: REVIEW_REQUEST_TAG },
];

beforeEach(() => {
  vi.resetAllMocks();
  mockHomeBlockCacheBust.mockResolvedValue(undefined);
  mockDbWrite.collection.findUnique.mockImplementation((({ where }: { where: { id: number } }) =>
    Promise.resolve(
      where.id === CONTEST
        ? {
            id: CONTEST,
            tags: [
              { tagId: CONCEPT_TAG, filterableOnly: false },
              { tagId: JUDGED_TAG, filterableOnly: true },
            ],
          }
        : where.id === OTHER
        ? { id: OTHER, tags: [{ tagId: OTHER_COLLECTION_TAG, filterableOnly: false }] }
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
  mockDbWrite.collectionItem.updateMany.mockResolvedValue({ count: WRITE_COUNT } as never);
});

const set = (
  items: Parameters<typeof setCollectionItemsTag>[0]['items'],
  tagId: number | null = CONCEPT_TAG,
  collectionId = CONTEST
) => setCollectionItemsTag({ collectionId, items, tagId });

describe('setCollectionItemsTag', () => {
  it('writes the tag to only the requested entries, scoped to the collection', async () => {
    const result = await set({ type: 'collectionItem', ids: [1, 2] });

    expect(result).toEqual({ count: WRITE_COUNT, collectionItemIds: [1, 2] });
    expect(mockDbWrite.collectionItem.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ collectionId: CONTEST, id: { in: [1, 2] } }),
      data: { tagId: CONCEPT_TAG },
    });
    expect(mockHomeBlockCacheBust).toHaveBeenCalledWith('Collection', CONTEST);
  });

  it.each([
    ['image', 12, 2],
    ['model', 14, 4],
    ['post', 15, 5],
    ['article', 16, 6],
  ] as const)('resolves an entry by its %s id', async (type, entityId, itemId) => {
    expect((await set({ type, ids: [entityId] })).collectionItemIds).toEqual([itemId]);
  });

  it('refuses an item from another collection and writes nothing', async () => {
    await expect(set({ type: 'collectionItem', ids: [1, 3] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Not in collection 100 (collectionItem): 3',
    });
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('does not match an image id against the collection item id', async () => {
    await expect(set({ type: 'image', ids: [1] })).rejects.toThrow(
      'Not in collection 100 (image): 1'
    );
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a tag that belongs to another collection, and writes nothing', async () => {
    await expect(
      set({ type: 'collectionItem', ids: [1] }, OTHER_COLLECTION_TAG)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  // filterableOnly tags carry system state (a daily challenge's judged marker decides its winners).
  it('refuses to set a filterableOnly tag', async () => {
    await expect(set({ type: 'collectionItem', ids: [1] }, JUDGED_TAG)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['a filterableOnly tag', 8],
    ['a tag the collection does not list', 9],
  ])('refuses to clear an entry holding %s', async (_, itemId) => {
    await expect(set({ type: 'collectionItem', ids: [1, itemId] }, null)).rejects.toThrow(
      `Carries a system tag, not a category (collectionItem): ${itemId}`
    );
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('only writes rows still untagged or category-tagged at write time', async () => {
    await set({ type: 'collectionItem', ids: [1] });

    expect(mockDbWrite.collectionItem.updateMany.mock.calls[0][0]?.where).toMatchObject({
      OR: [{ tagId: null }, { tagId: { in: [CONCEPT_TAG] } }],
    });
  });

  it('clears the tag with null', async () => {
    await set({ type: 'collectionItem', ids: [1] }, null);

    expect(mockDbWrite.collectionItem.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ collectionId: CONTEST, id: { in: [1] } }),
      data: { tagId: null },
    });
  });

  it('404s an unknown collection', async () => {
    await expect(set({ type: 'collectionItem', ids: [1] }, null, 999)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('reports a committed write even when the cache bust fails', async () => {
    mockHomeBlockCacheBust.mockRejectedValue(new Error('redis down'));
    loggingMock.logToAxiom.mockResolvedValue(undefined);

    await expect(set({ type: 'collectionItem', ids: [1] })).resolves.toEqual({
      count: WRITE_COUNT,
      collectionItemIds: [1],
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'collection-set-items-tag-cache-bust',
        collectionId: CONTEST,
      })
    );
  });
});
