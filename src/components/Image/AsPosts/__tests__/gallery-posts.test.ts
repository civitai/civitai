import { describe, expect, it } from 'vitest';
import { mergePostPages } from '~/components/Image/AsPosts/gallery-posts';

const card = (postId: number, imageIds: number[], imageCount?: number) => ({
  postId,
  images: imageIds.map((id) => ({ id })),
  ...(imageCount !== undefined && { imageCount }),
});
const shape = (posts: ReturnType<typeof card>[]) =>
  posts.map((x) => ({
    postId: x.postId,
    imageIds: x.images.map((i) => i.id),
    count: x.imageCount,
  }));

describe('mergePostPages', () => {
  // One post whose images ranked onto three pages, as in a Most Reactions model gallery.
  it('shows a post as one card, where it first appeared, holding the images of every page', () => {
    const pages = [
      [card(1, [11, 12]), card(2, [21])],
      [card(1, [13]), card(3, [31])],
      undefined,
      [card(1, [12, 14])],
    ];

    expect(shape(mergePostPages(pages))).toEqual([
      { postId: 1, imageIds: [11, 12, 13, 14], count: undefined },
      { postId: 2, imageIds: [21], count: undefined },
      { postId: 3, imageIds: [31], count: undefined },
    ]);
  });

  it("keeps a sponsored card to its own images, apart from the post's ordinary cards", () => {
    const sponsored = { ...card(1, [11]), sponsored: true };
    const posts = mergePostPages([[sponsored, card(2, [21])], [card(1, [11, 12])]]);

    expect(posts.map((x) => [x.postId, x.images.map((i) => i.id), !!x.sponsored])).toEqual([
      [1, [11], true],
      [2, [21], false],
      [1, [11, 12], false],
    ]);

    // The sponsored slot can also come after an ordinary card of the same post.
    const after = mergePostPages([[card(1, [12]), sponsored], [card(1, [13])]]);
    expect(after.map((x) => [x.postId, x.images.map((i) => i.id), !!x.sponsored])).toEqual([
      [1, [12, 13], false],
      [1, [11], true],
    ]);
  });

  // With lazy post images a card carries its first few images and the count of the whole post,
  // on every page it appears; the carousel loads the rest of the count on demand.
  it("keeps the post's count once, however many pages carry it", () => {
    const twice = mergePostPages([[card(1, [11, 12], 8)], [card(1, [13, 14], 8)]]);
    expect(shape(twice)).toEqual([{ postId: 1, imageIds: [11, 12, 13, 14], count: 8 }]);

    const repeated = mergePostPages([[card(1, [11, 12], 3)], [card(1, [12, 13], 3)]]);
    expect(shape(repeated)).toEqual([{ postId: 1, imageIds: [11, 12, 13], count: 3 }]);

    // A later card that counts more than the first one raises the count.
    const grown = mergePostPages([[card(1, [11, 12], 2)], [card(1, [12], 5)]]);
    expect(shape(grown)).toEqual([{ postId: 1, imageIds: [11, 12], count: 5 }]);
  });
});
