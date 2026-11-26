import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A model whose cover is someone else's image featured in its showcase: the search document gets
 * that one image so the card can show it, and the hoist finds it even on an older version. The rest
 * of the community showcase stays out of search.
 */

const community = {
  covers: new Map<string, { image: object; sites: Set<string> }>(),
  lookup: vi.fn(),
};

const heldLevels = { byModel: new Map<number, number>() };
// The two lookups, passed in: the model's featured covers, and its held gallery level.
const lookups = {
  communityCovers: async (covers: unknown) => {
    community.lookup(covers);
    return community.covers as never;
  },
  heldLevels: async () => heldLevels.byModel,
};

const { appendCommunityCoverImages, pickModelIndexImages } = await import(
  '~/server/search-index/models.search-index'
);

type Images = Parameters<typeof pickModelIndexImages>[2];
const owner = (id: number, modelVersionId: number) => ({
  id,
  modelVersionId,
  availability: 'Public',
});

beforeEach(() => {
  community.lookup.mockClear();
  heldLevels.byModel = new Map();
});

describe('the search document and a community cover', () => {
  it('looks up only covers missing from the list, and adds the one featured on its site', async () => {
    const featured = { id: 90, modelVersionId: 9, availability: 'Public', authorUsername: 'ann' };
    community.covers = new Map([['5:90', { image: featured, sites: new Set(['red']) }]]);
    const images = [owner(1, 10)] as unknown as Images;

    await appendCommunityCoverImages(
      [{ id: 5, coverImageId: 90, sfwCoverImageId: 1 }],
      images,
      lookups
    );

    expect(community.lookup).toHaveBeenCalledTimes(1);
    expect(community.lookup).toHaveBeenCalledWith([{ modelId: 5, imageId: 90, site: 'red' }]);
    expect(images.map((image) => image.id)).toEqual([1, 90]);
  });

  it('leaves out a featured cover listed on a report, like every image in the document', async () => {
    const featured = { id: 90, modelVersionId: 9, availability: 'Public', authorUsername: 'ann' };
    community.covers = new Map([['5:90', { image: featured, sites: new Set(['red']) }]]);
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ id: 90 }] as never);
    const images = [owner(1, 10)] as unknown as Images;

    await appendCommunityCoverImages([{ id: 5, coverImageId: 90 }], images, lookups);

    expect(images.map((image) => image.id)).toEqual([1]);
  });

  it('leaves out a cover featured only on the other site', async () => {
    const featured = { id: 90, modelVersionId: 9, availability: 'Public', authorUsername: 'ann' };
    community.covers = new Map([['5:90', { image: featured, sites: new Set(['red']) }]]);
    const images = [owner(1, 10)] as unknown as Images;

    await appendCommunityCoverImages(
      [{ id: 5, coverImageId: null, sfwCoverImageId: 90 }],
      images,
      lookups
    );

    expect(images.map((image) => image.id)).toEqual([1]);
  });

  it("keeps a held model's community cover within its gallery level", async () => {
    const mature = { id: 90, modelVersionId: 9, availability: 'Public', nsfwLevel: 4 };
    community.covers = new Map([['5:90', { image: mature, sites: new Set(['red']) }]]);
    const images = [owner(1, 10)] as unknown as Images;

    heldLevels.byModel = new Map([[5, 1 | 2]]);
    await appendCommunityCoverImages([{ id: 5, coverImageId: 90, minor: true }], images, lookups);
    expect(images.map((image) => image.id)).toEqual([1]);

    heldLevels.byModel = new Map();
    await appendCommunityCoverImages([{ id: 5, coverImageId: 90, minor: false }], images, lookups);
    expect(images.map((image) => image.id)).toEqual([1, 90]);
  });

  const versions = [
    { id: 10, baseModel: 'SDXL 1.0' },
    { id: 9, baseModel: 'SDXL 1.0' },
  ];

  it('hoists a community cover featured on an older version', async () => {
    const featured = { id: 90, modelVersionId: 9, availability: 'Public', authorUsername: 'ann' };
    community.covers = new Map([['5:90', { image: featured, sites: new Set(['red']) }]]);
    const images = [owner(1, 10)] as unknown as Images;
    await appendCommunityCoverImages([{ id: 5, coverImageId: 90 }], images, lookups);

    const picked = pickModelIndexImages({ id: 5, coverImageId: 90 }, versions, images);
    expect(picked.map((image) => image.id)).toEqual([90, 1]);
  });

  it('hoists a cover only for the models it was checked for, not another one in the batch', async () => {
    const mature = { id: 90, modelVersionId: 9, availability: 'Public', nsfwLevel: NsfwLevel.R };
    community.covers = new Map([
      ['5:90', { image: mature, sites: new Set(['red']) }],
      ['6:90', { image: mature, sites: new Set(['red']) }],
    ]);
    // Model 6 is held at PG and PG-13, so the image is checked and refused for it.
    heldLevels.byModel = new Map([[6, 1 | 2]]);
    const images = [owner(1, 10)] as unknown as Images;
    await appendCommunityCoverImages(
      [
        { id: 5, coverImageId: 90 },
        { id: 6, coverImageId: 90, minor: true },
      ],
      images,
      lookups
    );

    const forModel = (id: number) =>
      pickModelIndexImages({ id, coverImageId: 90 }, versions, images).map((image) => image.id);
    expect(forModel(5)).toEqual([90, 1]);
    expect(forModel(6)).toEqual([1]);
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
