import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CollectionService from '~/server/services/collection.service';

// A post's entry category in a contest collection, changed from the post editor.

const { getCollectionById } = vi.hoisted(() => ({ getCollectionById: vi.fn() }));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById,
}));
// Reached at import through the orchestrator caller, which throws without a token.
vi.mock('~/server/services/training.service', () => ({}));

const { updatePostCollectionTagId } = await import('~/server/services/post.service');

const POST_ID = 1;
const COLLECTION_ID = 5;
const CATEGORY_A = 10;
const CATEGORY_B = 11;
const SYSTEM_TAG = 99;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.post.findUnique.mockResolvedValue({
    collectionId: COLLECTION_ID,
    userId: 7,
  } as never);
  dbMock.dbRead.image.findMany.mockResolvedValue([{ id: 40 }, { id: 41 }] as never);
  dbMock.dbWrite.collectionItem.updateMany.mockResolvedValue({ count: 2 } as never);
  // The shape getCollectionById returns (collection.selector.ts / hot-reads-10.reads.ts).
  getCollectionById.mockResolvedValue({
    id: COLLECTION_ID,
    mode: 'Contest',
    type: 'Image',
    tags: [
      { tag: { id: CATEGORY_A, name: 'A' }, filterableOnly: false },
      { tag: { id: CATEGORY_B, name: 'B' }, filterableOnly: false },
      { tag: { id: SYSTEM_TAG, name: 'Judged' }, filterableOnly: true },
    ],
  });
});

const change = (collectionTagId: number) =>
  updatePostCollectionTagId({ id: POST_ID, collectionTagId });

describe("changing a contest post's entry category", () => {
  it("moves the post's entries to another category", async () => {
    await change(CATEGORY_B);
    expect(dbMock.dbWrite.collectionItem.updateMany).toHaveBeenCalledOnce();
    expect(dbMock.dbWrite.collectionItem.updateMany.mock.calls[0][0]).toMatchObject({
      where: { collectionId: COLLECTION_ID, imageId: { in: [40, 41] } },
      data: { tagId: CATEGORY_B },
    });
  });

  it('leaves entries that carry a tag other than a category alone', async () => {
    await change(CATEGORY_B);
    expect(dbMock.dbWrite.collectionItem.updateMany.mock.calls[0][0]).toMatchObject({
      where: { OR: [{ tagId: null }, { tagId: { in: [CATEGORY_A, CATEGORY_B] } }] },
    });
  });

  it.each([
    ['a tag the collection only filters by', SYSTEM_TAG],
    ['a tag the collection does not have', 12345],
  ])('refuses %s', async (_, tagId) => {
    await expect(change(tagId)).rejects.toMatchObject({ message: 'Invalid tag' });
    expect(dbMock.dbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });
});
