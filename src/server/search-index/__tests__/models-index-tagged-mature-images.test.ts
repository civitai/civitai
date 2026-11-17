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

describe("a model's search document images, by tag and level", () => {
  it.each(childBrowsingTagIds)('leaves out an image above PG13 tagged %i', (tagId) => {
    expect(
      pick([
        image(1, NsfwLevel.R, [tagId]),
        image(2, NsfwLevel.X, [7, tagId]),
        image(3, NsfwLevel.XXX, [tagId]),
      ])
    ).toEqual([]);
  });

  it('keeps an image above PG13 without those tags, and a PG or PG13 image with them', () => {
    const [tagId] = childBrowsingTagIds;
    expect(
      pick([
        image(1, NsfwLevel.R, [7]),
        image(2, NsfwLevel.PG, [tagId]),
        image(3, NsfwLevel.PG13, [tagId]),
        image(4, NsfwLevel.X),
      ])
    ).toEqual([1, 2, 3, 4]);
  });

  it('does not hoist a left-out cover', () => {
    const [tagId] = childBrowsingTagIds;
    expect(pick([image(1, NsfwLevel.PG), image(2, NsfwLevel.R, [tagId])], 2)).toEqual([1]);
  });
});
