import { childBrowsingTagIds } from '@civitai/shared';
import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { pickModelIndexImages } from '~/server/search-index/models.search-index';

const versions = [{ id: 10, baseModel: 'SDXL 1.0' }];
const image = (id: number, nsfwLevel: NsfwLevel, tags: number[] = []) => ({
  id,
  modelVersionId: 10,
  availability: 'Public',
  nsfwLevel,
  tags,
});
const pick = (images: ReturnType<typeof image>[], coverImageId?: number) =>
  pickModelIndexImages(
    { coverImageId },
    versions,
    images as unknown as Parameters<typeof pickModelIndexImages>[2]
  ).map((i) => i.id);

describe("a model's search document images, by browsing tag", () => {
  it.each(childBrowsingTagIds)('keeps an image above PG13 tagged %i', (tagId) => {
    expect(
      pick([
        image(1, NsfwLevel.R, [tagId]),
        image(2, NsfwLevel.X, [7, tagId]),
        image(3, NsfwLevel.XXX, [tagId]),
      ])
    ).toEqual([1, 2, 3]);
  });

  it('hoists a tagged cover', () => {
    const [tagId] = childBrowsingTagIds;
    expect(pick([image(1, NsfwLevel.PG), image(2, NsfwLevel.R, [tagId])], 2)).toEqual([2, 1]);
  });
});
