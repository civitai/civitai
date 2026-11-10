import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `collection.getAllCollectionItems` asks the service to answer a collection the viewer may not
 * read as a missing one (`requireRead`); the rule itself is pinned in
 * collection-item-read-permission.test.ts.
 */
const { getItems, getEntryCount } = vi.hoisted(() => ({
  getItems: vi.fn(),
  getEntryCount: vi.fn(),
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCollectionItemsByCollectionId: getItems,
  getCollectionEntryCount: getEntryCount,
}));

const { collectionItemsInfiniteHandler, getCollectionEntryCountHandler } = await import(
  '~/server/controllers/collection.controller'
);

beforeEach(() => {
  vi.clearAllMocks();
  getItems.mockResolvedValue({ items: [], nextCursor: undefined });
});

describe('collectionItemsInfiniteHandler', () => {
  it('requires the viewer to be able to read the collection', async () => {
    await collectionItemsInfiniteHandler({
      input: { collectionId: 7 } as never,
      ctx: { user: { id: 77, isModerator: false } } as never,
    });
    expect(getItems).toHaveBeenCalledWith(expect.objectContaining({ requireRead: true }));
  });
});

describe('getCollectionEntryCountHandler', () => {
  it('counts for the viewer, with their moderator status', async () => {
    await getCollectionEntryCountHandler({
      input: { id: 7 },
      ctx: { user: { id: 78, isModerator: true } } as never,
    });
    expect(getEntryCount).toHaveBeenCalledWith({ collectionId: 7, userId: 78, isModerator: true });
  });
});
