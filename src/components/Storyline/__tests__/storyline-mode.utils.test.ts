import { describe, expect, it } from 'vitest';
import {
  getStorylineStep,
  getStorylineWalk,
  hideHiddenUsersChapters,
  orderPathImages,
  parseIdParam,
  resolvePendingContinue,
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

describe('parseIdParam', () => {
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
    expect(parseIdParam(value)).toBe(expected);
  });
});

describe('orderPathImages tie-breaks', () => {
  it('falls back to id when two images in one post share or lack an index', () => {
    const images = [
      { id: 12, postId: 100, index: null },
      { id: 11, postId: 100, index: null },
      { id: 10, postId: 100, index: 0 },
    ];
    expect(orderPathImages(images, [100]).map((i) => i.id)).toEqual([10, 11, 12]);
  });
});

describe('hideHiddenUsersChapters', () => {
  it("turns a hidden user's chapter into an unavailable tombstone and leaves the rest", () => {
    const chapters = [
      visible(1, 0, 100),
      { ...visible(2, 1, 200), post: { ...visible(2, 1, 200).post!, userId: 7 } },
    ];
    const result = hideHiddenUsersChapters(chapters, new Set([7]));
    expect(result.map((c) => [c.chapterId, c.tombstone, c.post?.id ?? null])).toEqual([
      [1, null, 100],
      [2, 'unavailable', null],
    ]);
  });
});

describe('resolvePendingContinue', () => {
  const first = new Map([[5, 50]]);
  it('waits while the path still ends at the previous chapter', () => {
    expect(
      resolvePendingContinue({
        pendingChapterId: 5,
        pathEndId: 4,
        imagesFetching: false,
        firstImageIdByChapterId: first,
      })
    ).toEqual({ kind: 'wait' });
  });
  it("waits while the branch's images are still loading", () => {
    expect(
      resolvePendingContinue({
        pendingChapterId: 5,
        pathEndId: 5,
        imagesFetching: true,
        firstImageIdByChapterId: new Map(),
      })
    ).toEqual({ kind: 'wait' });
  });
  it("opens the branch's first image once it has arrived", () => {
    expect(
      resolvePendingContinue({
        pendingChapterId: 5,
        pathEndId: 5,
        imagesFetching: false,
        firstImageIdByChapterId: first,
      })
    ).toEqual({ kind: 'open', imageId: 50 });
  });
  it('shows the end-of-chapter view for a branch with nothing this reader can see', () => {
    expect(
      resolvePendingContinue({
        pendingChapterId: 5,
        pathEndId: 5,
        imagesFetching: false,
        firstImageIdByChapterId: new Map(),
      })
    ).toEqual({ kind: 'end' });
  });
});

describe('getStorylineStep', () => {
  it.each([
    [0, 3, 'next', 'move'],
    [1, 3, 'next', 'move'],
    [2, 3, 'next', 'end'],
    [0, 1, 'next', 'end'],
    [0, 3, 'previous', 'stay'],
    [2, 3, 'previous', 'move'],
  ] as const)('index %i of %i, %s -> %s', (index, length, direction, expected) => {
    expect(getStorylineStep(index, length, direction)).toBe(expected);
  });
});
