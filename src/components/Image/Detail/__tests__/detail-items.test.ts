import { describe, expect, test } from 'vitest';
import { anchorImageIndex, mergeDetailItems } from '~/components/Image/Detail/detail-items';

const image = (id: number, postId: number, index: number) => ({ id, postId, index });
const text = (id: number, postId: number, index: number) => ({ id, postId, index, nsfwLevel: 1 });
const keys = (items: { key: string }[]) => items.map((item) => item.key);

describe('mergeDetailItems', () => {
  test('with no texts the slides are the images, one for one and in the same order', () => {
    // Out of index order on purpose: a feed-seeded carousel is not sorted, and must not be.
    const images = [image(3, 1, 2), image(1, 1, 0), image(2, 1, 1)];
    for (const texts of [undefined, []]) {
      const items = mergeDetailItems(images, texts);
      expect(items.map((item) => item.type === 'image' && item.image)).toEqual(images);
    }
  });

  test('a text sits after the image whose index it took, before the next', () => {
    const items = mergeDetailItems(
      [image(1, 1, 0), image(2, 1, 1), image(3, 1, 2)],
      [text(7, 1, 1), text(5, 1, -1)]
    );
    expect(keys(items)).toEqual(['txt:5', 'img:1', 'img:2', 'txt:7', 'img:3']);
  });

  test('on a path, texts stay in their own chapter, and one with no images keeps its place', () => {
    const items = mergeDetailItems(
      [image(1, 10, 0), image(2, 10, 1), image(3, 30, 0)],
      [text(8, 10, 5), text(9, 20, 0), text(4, 99, 0)],
      [10, 20, 30]
    );
    // Post 99 is not on the path: its text is left out.
    expect(keys(items)).toEqual(['img:1', 'img:2', 'txt:8', 'txt:9', 'img:3']);
  });
});

describe('anchorImageIndex', () => {
  test('a text slide is anchored on the image before it, or after it when it comes first', () => {
    const items = mergeDetailItems(
      [image(1, 1, 0), image(2, 1, 1)],
      [text(5, 1, -1), text(6, 1, 0)]
    );
    expect(keys(items)).toEqual(['txt:5', 'img:1', 'txt:6', 'img:2']);
    expect([0, 1, 2, 3].map((i) => anchorImageIndex(items, i))).toEqual([1, 1, 1, 3]);
  });
});
