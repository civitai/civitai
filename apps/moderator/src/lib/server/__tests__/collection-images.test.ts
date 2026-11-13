import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The collection queue's image pages (`collectionImages`): 60 at a time, and clamped to the last page
 * so a collection that shrank under the moderator does not open on an empty grid.
 */

const getImagesForCollection = vi.fn(
  async (_id: number, { offset = 0 }: { limit?: number; offset?: number }) => ({
    items: [],
    total: 130,
    truncated: offset + 60 < 130,
    offset,
  })
);
vi.mock('../bulk-image.service', () => ({
  getImagesForCollection,
  getImagesForConnection: vi.fn(),
}));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: () => null }));

const { collectionImages, COLLECTION_IMAGES_PER_PAGE } = await import('../entity-queue-load');

beforeEach(() => vi.clearAllMocks());

describe('collectionImages', () => {
  it('reads the asked-for page', async () => {
    const batch = await collectionImages(5, 2);
    expect(getImagesForCollection).toHaveBeenCalledWith(5, {
      limit: COLLECTION_IMAGES_PER_PAGE,
      offset: COLLECTION_IMAGES_PER_PAGE,
    });
    expect(batch).toMatchObject({ page: 2, perPage: 60, total: 130 });
  });

  it('clamps a page past the end to the last one', async () => {
    const batch = await collectionImages(5, 9);
    expect(getImagesForCollection).toHaveBeenLastCalledWith(5, { limit: 60, offset: 120 });
    expect(batch.page).toBe(3);
  });

  it('an empty collection is page 1', async () => {
    getImagesForCollection.mockResolvedValue({ items: [], total: 0, truncated: false, offset: 0 });
    expect((await collectionImages(5, 4)).page).toBe(1);
  });
});
