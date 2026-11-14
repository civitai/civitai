import { describe, expect, it, vi } from 'vitest';

/**
 * A model whose cover is someone else's image featured in its showcase: the search document gets
 * that one image so the card can show it, and the hoist finds it even on an older version. The rest
 * of the community showcase stays out of search.
 */

const community = vi.hoisted(() => ({
  covers: new Map<string, { image: object; sites: Set<string> }>(),
  lookup: vi.fn(),
}));
vi.mock('~/server/services/version-showcase.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShowcaseCommunityCovers: vi.fn(async (covers: unknown) => {
    community.lookup(covers);
    return community.covers;
  }),
}));

const { appendCommunityCoverImages, pickModelIndexImages } = await import(
  '~/server/search-index/models.search-index'
);

type Images = Parameters<typeof pickModelIndexImages>[2];
const owner = (id: number, modelVersionId: number) => ({
  id,
  modelVersionId,
  availability: 'Public',
});

describe('the search document and a community cover', () => {
  it('looks up only covers missing from the list, and adds the one featured on its site', async () => {
    const featured = { id: 90, modelVersionId: 9, availability: 'Public', authorUsername: 'ann' };
    community.covers = new Map([['5:90', { image: featured, sites: new Set(['red']) }]]);
    const images = [owner(1, 10)] as unknown as Images;

    await appendCommunityCoverImages([{ id: 5, coverImageId: 90, sfwCoverImageId: 1 }], images);

    expect(community.lookup).toHaveBeenCalledWith([{ modelId: 5, imageId: 90, site: 'red' }]);
    expect(images.map((image) => image.id)).toEqual([1, 90]);
  });

  it('leaves out a cover featured only on the other site', async () => {
    const featured = { id: 90, modelVersionId: 9, availability: 'Public', authorUsername: 'ann' };
    community.covers = new Map([['5:90', { image: featured, sites: new Set(['red']) }]]);
    const images = [owner(1, 10)] as unknown as Images;

    await appendCommunityCoverImages([{ id: 5, coverImageId: null, sfwCoverImageId: 90 }], images);

    expect(images.map((image) => image.id)).toEqual([1]);
  });

  it('hoists a community cover featured on an older version', () => {
    const images = [
      owner(1, 10),
      { id: 90, modelVersionId: 9, availability: 'Public', authorUsername: 'ann' },
    ] as unknown as Images;
    const picked = pickModelIndexImages(
      { coverImageId: 90 },
      [
        { id: 10, baseModel: 'SDXL 1.0' },
        { id: 9, baseModel: 'SDXL 1.0' },
      ],
      images
    );
    expect(picked.map((image) => image.id)).toEqual([90, 1]);
  });

  it("doesn't hoist an owner image from an older version, as before", () => {
    const images = [owner(1, 10), owner(2, 9)] as unknown as Images;
    const picked = pickModelIndexImages(
      { coverImageId: 2 },
      [
        { id: 10, baseModel: 'SDXL 1.0' },
        { id: 9, baseModel: 'SDXL 1.0' },
      ],
      images
    );
    expect(picked.map((image) => image.id)).toEqual([1]);
  });
});
