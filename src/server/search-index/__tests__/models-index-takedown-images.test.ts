import { describe, expect, it } from 'vitest';
import { pickModelIndexImages, withheldCoverIds } from '~/server/search-index/models.search-index';
import { ModelModifier } from '~/shared/utils/prisma/enums';

const versions = [{ id: 10, baseModel: 'SDXL 1.0' }];
const images = [
  { id: 1, modelVersionId: 10, availability: 'Public' },
  { id: 2, modelVersionId: 10, availability: 'Public' },
] as unknown as Parameters<typeof pickModelIndexImages>[2];

describe("a model's search document images", () => {
  it('lists a taken-down model with no images', () => {
    const picked = pickModelIndexImages(
      { mode: ModelModifier.TakenDown, coverImageId: 2 },
      versions,
      images
    );
    expect(picked).toEqual([]);
  });

  it.each([
    ['an archived model', ModelModifier.Archived],
    ['a model in no mode', null],
  ])('keeps the images of %s, its cover first', (_name, mode) => {
    const picked = pickModelIndexImages({ mode, coverImageId: 2 }, versions, images);
    expect(picked.map((image) => image.id)).toEqual([2, 1]);
  });
});

describe("a model's search document cover ids", () => {
  const model = { coverImageId: 2, sfwCoverImageId: 1 };

  it('clears both for a taken-down model', () => {
    expect({ ...model, ...withheldCoverIds({ mode: ModelModifier.TakenDown }) }).toEqual({
      coverImageId: null,
      sfwCoverImageId: null,
    });
  });

  it('keeps them for an archived model', () => {
    expect({ ...model, ...withheldCoverIds({ mode: ModelModifier.Archived }) }).toEqual(model);
  });
});
