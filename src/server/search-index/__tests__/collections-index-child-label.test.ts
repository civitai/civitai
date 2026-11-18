import { describe, expect, it } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { NsfwLevel } from '~/server/common/enums';
import { transformData } from '~/server/search-index/collections.search-index';

const CHILD_TAG = childBrowsingTagIds[0];
const OTHER_TAG = 999001;

const collection = (id: number, image: { id: number; nsfwLevel: number } | null) =>
  ({ id, nsfwLevel: 1, cosmetics: [], user: { id: 2, profilePictureId: null }, image } as never);
const item = (
  collectionId: number,
  imageId: number,
  nsfwLevel: number,
  src: string | null = null
) => ({ id: collectionId, image: { id: imageId, nsfwLevel }, src } as never);
const tag = (imageId: number, tagId: number) => ({ imageId, tagId });

async function records() {
  const { records } = await transformData({
    collections: [
      collection(1, { id: 100, nsfwLevel: NsfwLevel.R }),
      collection(2, { id: 200, nsfwLevel: NsfwLevel.R }),
      collection(3, null),
    ],
    itemImages: [
      item(3, 300, NsfwLevel.R, 'src-300'),
      item(3, 301, NsfwLevel.R, 'src-301'),
      item(3, 302, NsfwLevel.PG13),
    ],
    tags: [tag(100, CHILD_TAG), tag(200, OTHER_TAG), tag(300, CHILD_TAG), tag(302, CHILD_TAG)],
    profilePictures: [],
    disqualifiedIds: [],
  } as never);
  return records.map((r) => ({
    id: r.id,
    image: r.image?.id ?? null,
    images: r.images.map((i) => i.id),
    srcs: r.srcs,
  }));
}

describe('collections search index and child-tagged images', () => {
  it('leaves out a cover or item image above PG13 carrying a child tag, with its cover string', async () => {
    expect(await records()).toEqual([
      { id: 1, image: null, images: [], srcs: [] },
      { id: 2, image: 200, images: [], srcs: [] },
      { id: 3, image: null, images: [301, 302], srcs: ['src-301'] },
    ]);
  });
});
