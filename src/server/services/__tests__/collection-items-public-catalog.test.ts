import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

/**
 * `getCollectionItemsByCollectionId({ imagesAsPublicCatalog: true })` must read its image
 * items the way `runImageSearch` does for /api/v1/blocks/images: no viewer (so no owner or
 * moderator carve-outs in `getAllImages`) and with the poi/minor exclusion. Without the
 * option the viewer's own read is unchanged.
 */

const { mockGetAllImages } = vi.hoisted(() => ({ mockGetAllImages: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: mockGetAllImages,
}));

import { getCollectionItemsByCollectionId } from '~/server/services/collection.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODERATOR = { id: 42, isModerator: true } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbRead.collection.findUniqueOrThrow).mockResolvedValue({
    id: 7,
    type: 'Image',
    mode: null,
  } as never);
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) =>
    strings.join('?').includes('FROM "CollectionItem" ci')
      ? [{ id: 1, imageId: 5, modelId: null, postId: null, articleId: null, createdAt: null }]
      : []) as never);
  mockGetAllImages.mockResolvedValue({ items: [{ id: 5 }] });
});

const read = (imagesAsPublicCatalog?: boolean) =>
  getCollectionItemsByCollectionId({
    input: { collectionId: 7, limit: 10, browsingLevel: 3, statuses: ['ACCEPTED'] } as never,
    user: MODERATOR,
    imagesAsPublicCatalog,
  });

describe('getCollectionItemsByCollectionId image read', () => {
  it('reads images with no viewer and the poi/minor exclusion when imagesAsPublicCatalog is set', async () => {
    const { items } = await read(true);
    expect(items.map((i) => i.type)).toEqual(['image']);
    expect(mockGetAllImages).toHaveBeenCalledTimes(1);
    const args = mockGetAllImages.mock.calls[0][0];
    expect(args.ids).toEqual([5]);
    expect(args.user).toBeUndefined();
    expect(args.disablePoi).toBe(true);
    expect(args.disableMinor).toBe(true);
    // getAllImages refuses acceptableMinor only when no collectionId is passed.
    expect(args).not.toHaveProperty('collectionId');
  });

  it("keeps the viewer's own read without the option", async () => {
    await read();
    const args = mockGetAllImages.mock.calls[0][0];
    expect(args.user).toBe(MODERATOR);
    expect(args.disablePoi).toBeUndefined();
    expect(args.disableMinor).toBeUndefined();
  });
});
