import { describe, expect, it } from 'vitest';
import {
  getStorylineWalk,
  orderPathImages,
  parseStorylineChapterParam,
} from '~/components/Storyline/storyline-mode.utils';
import type { StorylinePathChapter } from '~/server/services/storyline.service';

function visible(chapterId: number, depth: number, postId: number): StorylinePathChapter {
  return {
    chapterId,
    depth,
    tombstone: null,
    post: { id: postId, title: `Chapter ${depth + 1}`, userId: 1, username: 'author' },
  };
}
function hidden(chapterId: number, depth: number): StorylinePathChapter {
  return { chapterId, depth, tombstone: 'browsingLevel', post: null };
}

describe('orderPathImages', () => {
  it('orders by the path, then by image index within a chapter, whatever order the feed returned', () => {
    // The image query orders by recency, so the newest chapter's images arrive first.
    const images = [
      { id: 31, postId: 300, index: 1 },
      { id: 30, postId: 300, index: 0 },
      { id: 11, postId: 100, index: 1 },
      { id: 10, postId: 100, index: 0 },
      { id: 99, postId: 999, index: 0 },
    ];
    expect(orderPathImages(images, [100, 300]).map((i) => i.id)).toEqual([10, 11, 30, 31]);
  });
});

describe('getStorylineWalk', () => {
  it('maps each image to its chapter and skips a hidden chapter instead of failing on it', () => {
    const chapters = [visible(1, 0, 100), hidden(2, 1), visible(3, 2, 300)];
    const walk = getStorylineWalk(chapters, [
      { id: 10, postId: 100 },
      { id: 11, postId: 100 },
      { id: 30, postId: 300 },
    ]);
    expect([...walk.chapterIdByImageId]).toEqual([
      [10, 1],
      [11, 1],
      [30, 3],
    ]);
    expect([...walk.firstImageIdByChapterId]).toEqual([
      [1, 10],
      [3, 30],
    ]);
    expect(walk.firstImageIdByChapterId.has(2)).toBe(false);
  });
});

describe('parseStorylineChapterParam', () => {
  it.each([
    ['12', 12],
    [12, 12],
    [['7', '8'], 7],
    ['null', undefined],
    ['0', undefined],
    ['-3', undefined],
    ['1.5', undefined],
    [undefined, undefined],
  ])('%j -> %j', (value, expected) => {
    expect(parseStorylineChapterParam(value)).toBe(expected);
  });
});
