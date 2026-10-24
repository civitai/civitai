import { describe, expect, it, vi } from 'vitest';
import { isAdjacent } from '~/components/Image/DetailV2/image-detail-carousel.utils';
import {
  buildSubwayStops,
  canonAheadForkStops,
  getForkShare,
  getPathImagesPaging,
  getStorylineChapterName,
  getStorylineStep,
  getStorylineWalk,
  hideHiddenUsersChapters,
  storylinePositionLabel,
  orderPathImages,
  parseIdListParam,
  parseIdParam,
  resolvePendingContinue,
  routeVia,
  STORYLINE_CHAPTER_PARAM,
  STORYLINE_VIA_PARAM,
  storylineReadHref,
  uniquePostIds,
  withStorylineNavigation,
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

describe('withStorylineNavigation', () => {
  const nav = (index: number) => ({ index, next: vi.fn(), previous: vi.fn() });

  it('hands back the carousel untouched outside a storyline, so the feed still loops', () => {
    const carousel = nav(2);
    expect(withStorylineNavigation(carousel, 3, undefined)).toBe(carousel);
  });

  it('opens the end-of-chapter view past the last image instead of wrapping to the first', () => {
    const carousel = nav(2);
    const onEnd = vi.fn();
    withStorylineNavigation(carousel, 3, onEnd).next();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(carousel.next).not.toHaveBeenCalled();
  });

  it('moves within the path and stays put before the first image', () => {
    const middle = nav(1);
    withStorylineNavigation(middle, 3, vi.fn()).next();
    expect(middle.next).toHaveBeenCalledTimes(1);
    const first = nav(0);
    withStorylineNavigation(first, 3, vi.fn()).previous();
    expect(first.previous).not.toHaveBeenCalled();
  });

  it('closes the open end-of-chapter view on previous and stays on the last image', () => {
    const last = nav(2);
    const onCloseEnd = vi.fn();
    withStorylineNavigation(last, 3, vi.fn(), onCloseEnd).previous();
    expect(onCloseEnd).toHaveBeenCalledTimes(1);
    expect(last.previous).not.toHaveBeenCalled();
  });

  it('closes the end-of-chapter view of a one-image chapter, where previous would stay put', () => {
    const only = nav(0);
    const onCloseEnd = vi.fn();
    withStorylineNavigation(only, 1, vi.fn(), onCloseEnd).previous();
    expect(onCloseEnd).toHaveBeenCalledTimes(1);
  });

  it('steps back normally once the end-of-chapter view is closed', () => {
    const last = nav(2);
    withStorylineNavigation(last, 3, vi.fn(), undefined).previous();
    expect(last.previous).toHaveBeenCalledTimes(1);
  });
});

describe('uniquePostIds', () => {
  it('keeps arrival order, drops repeats and images with no post', () => {
    expect(
      uniquePostIds([{ postId: 3 }, { postId: 1 }, { postId: 3 }, { postId: null }, {}])
    ).toEqual([3, 1]);
  });
});

describe('isAdjacent', () => {
  it('treats the first and last slides as neighbours only when looping', () => {
    expect(isAdjacent(4, 0, 5, true)).toBe(true);
    expect(isAdjacent(4, 0, 5, false)).toBe(false);
    expect(isAdjacent(1, 0, 5, false)).toBe(true);
  });
});

describe('getPathImagesPaging', () => {
  const base = { hasNextPage: true, isFetching: false, isError: false, pages: 1, maxPages: 10 };
  it('asks for the next page while the path has more', () => {
    expect(getPathImagesPaging(base)).toEqual({ fetchNext: true, loading: true });
  });
  it('does not stack a request on one in flight', () => {
    expect(getPathImagesPaging({ ...base, isFetching: true })).toEqual({
      fetchNext: false,
      loading: true,
    });
  });
  it('stops, and stops reporting loading, after a failed page', () => {
    expect(getPathImagesPaging({ ...base, isError: true })).toEqual({
      fetchNext: false,
      loading: false,
    });
  });
  it('stops at the page cap', () => {
    expect(getPathImagesPaging({ ...base, pages: 10 })).toEqual({
      fetchNext: false,
      loading: false,
    });
  });
  it('is done when there is no next page', () => {
    expect(getPathImagesPaging({ ...base, hasNextPage: false })).toEqual({
      fetchNext: false,
      loading: false,
    });
  });
});

describe('withStorylineNavigation, the other steps', () => {
  it('steps back from the middle and opens the end from the last of a longer path', () => {
    const middle = { index: 2, next: vi.fn(), previous: vi.fn() };
    withStorylineNavigation(middle, 5, vi.fn()).previous();
    expect(middle.previous).toHaveBeenCalledTimes(1);
    const last = { index: 4, next: vi.fn(), previous: vi.fn() };
    const onEnd = vi.fn();
    withStorylineNavigation(last, 5, onEnd).next();
    expect([onEnd.mock.calls.length, last.next.mock.calls.length]).toEqual([1, 0]);
  });
});

describe('isAdjacent, boundaries', () => {
  it('counts only immediate neighbours, and a lone slide is adjacent only to itself', () => {
    expect(isAdjacent(2, 0, 5, true)).toBe(false);
    expect(isAdjacent(0, 0, 1, false)).toBe(true);
    expect(isAdjacent(1, 0, 1, true)).toBe(false);
  });
});

describe('buildSubwayStops', () => {
  it('runs the path then the canon line ahead, hanging other continuations off their stop', () => {
    const path = [visible(1, 0, 100), visible(2, 1, 200)];
    const ahead = [visible(3, 2, 300), visible(4, 3, 400)];
    const children = new Map([
      [1, [visible(2, 1, 200), visible(8, 1, 800)]],
      [2, [visible(3, 2, 300), visible(9, 2, 900)]],
      [4, [visible(5, 4, 500), visible(6, 4, 600)]],
    ]);
    const stops = buildSubwayStops(path, ahead, children);
    expect(
      stops.map((s) => [s.chapter.chapterId, s.kind, s.branches.map((b) => b.chapterId)])
    ).toEqual([
      [1, 'path', [8]],
      [2, 'path', [9]],
      [3, 'ahead', []],
      // The end of the line: every continuation is a branch.
      [4, 'ahead', [5, 6]],
    ]);
  });
});

describe('buildSubwayStops through a rejoin', () => {
  // 31 and 40 carry depth 2, as if reached by a shorter route; the line numbers them by position (3).
  const path = [
    visible(1, 0, 100),
    visible(21, 1, 210),
    { ...visible(30, 2, 300), parentCount: 2, joins: [visible(11, 1, 110)] },
  ];
  const ahead = [visible(31, 2, 310)];
  const children = new Map([[30, [visible(31, 2, 310), visible(40, 2, 400)]]]);

  it('numbers stops and the ways off them along the line, not by their own depth', () => {
    const stops = buildSubwayStops(path, ahead, children);
    expect(stops.map((s) => [s.chapter.chapterId, s.chapter.depth])).toEqual([
      [1, 0],
      [21, 1],
      [30, 2],
      [31, 3],
    ]);
    expect(stops[2].branches.map((b) => [b.chapterId, b.depth])).toEqual([[40, 3]]);
  });

  it('marks the stop where the other branch joins, and only that one', () => {
    const stops = buildSubwayStops(path, ahead, children);
    expect(stops.map((s) => s.joins.map((j) => j.chapterId))).toEqual([[], [], [11], []]);
  });
});

describe('routeVia', () => {
  it('names the chapter before each rejoined chapter on the route', () => {
    expect(
      routeVia([
        { chapterId: 1 },
        { chapterId: 21, parentCount: 1 },
        { chapterId: 30, parentCount: 2 },
        { chapterId: 31, parentCount: 1 },
        { chapterId: 50, parentCount: 3 },
      ])
    ).toEqual([21, 31]);
  });

  it('is empty on a route with no rejoin, so every link stays as it was', () => {
    expect(routeVia([{ chapterId: 1 }, { chapterId: 2, parentCount: 1 }])).toEqual([]);
    // The first stop has no chapter before it on the route to name.
    expect(routeVia([{ chapterId: 30, parentCount: 2 }])).toEqual([]);
  });
});

describe('parseIdListParam', () => {
  it.each([
    ['12,34', [12, 34]],
    ['12,x,0,5', [12, 5]],
    [15, [15]],
    [
      ['7,8', '9'],
      [7, 8],
    ],
    ['', []],
    [undefined, []],
    // Past Postgres int4: the server would refuse the whole read, so the id is dropped.
    ['3000000000,12', [12]],
    ['2147483647', [2147483647]],
  ])('%j -> %j', (value, expected) => {
    expect(parseIdListParam(value)).toEqual(expected);
  });

  it('keeps no more ids than a path has chapters', () => {
    const many = Array.from({ length: 250 }, (_, i) => i + 1).join(',');
    expect(parseIdListParam(many)).toHaveLength(200);
  });
});

describe('getStorylineChapterName', () => {
  it('uses the title, else the number, adding the author only where asked', () => {
    const titled = {
      ...visible(2, 1, 200),
      post: { ...visible(2, 1, 200).post!, title: 'The painting' },
    };
    const untitled = { ...visible(2, 1, 200), post: { ...visible(2, 1, 200).post!, title: null } };
    expect(getStorylineChapterName(titled, { withAuthor: true })).toBe('The painting');
    expect(getStorylineChapterName(untitled, { withAuthor: true })).toBe('Chapter 2 by author');
    expect(getStorylineChapterName(untitled)).toBe('Chapter 2');
    expect(getStorylineChapterName(hidden(3, 2))).toBe(
      'This chapter is hidden by your browsing level'
    );
  });
});

describe('getForkShare', () => {
  it('reads each way as a percent and its readers, a way nobody took as 0', () => {
    const shares = { total: 8, shares: { 1: 0.75, 2: 0.25 } };
    expect([getForkShare(shares, 1), getForkShare(shares, 3)]).toEqual([
      { percent: 75, readers: 6 },
      { percent: 0, readers: 0 },
    ]);
  });

  it('gives nothing before the shares are read, at zero, or when a split is withheld', () => {
    expect([
      getForkShare(undefined, 1),
      getForkShare({ total: 0, shares: {} }, 1),
      getForkShare({ total: 3, shares: {} }, 1),
    ]).toEqual([null, null, null]);
  });
});

describe('canonAheadForkStops', () => {
  const stop = (chapterId: number, childCount: number) => ({ chapterId, childCount });

  it('takes a mid-line stop only when it has more than its canon child', () => {
    expect(canonAheadForkStops([stop(5, 1), stop(6, 2), stop(7, 1), stop(8, 0)], 10)).toEqual([6]);
  });

  it('takes the last stop with any child, since none of them is canon', () => {
    expect(canonAheadForkStops([stop(5, 1), stop(6, 1)], 10)).toEqual([6]);
  });

  it('keeps the nearest stops when there are more than the limit', () => {
    const line = [stop(1, 3), stop(2, 3), stop(3, 3), stop(4, 3)];
    expect(canonAheadForkStops(line, 2)).toEqual([1, 2]);
  });

  it('counts the limit in forks, not in stops, so a long straight run does not hide them', () => {
    const line = [stop(1, 1), stop(2, 1), stop(3, 3), stop(4, 1), stop(5, 3), stop(6, 2)];
    expect(canonAheadForkStops(line, 2)).toEqual([3, 5]);
  });
});

describe('storylineReadHref', () => {
  const read = (href: string) => {
    const url = new URL(href, 'https://civitai.com');
    return {
      path: url.pathname,
      chapterId: parseIdParam(url.searchParams.get(STORYLINE_CHAPTER_PARAM)),
      via: parseIdListParam(url.searchParams.get(STORYLINE_VIA_PARAM)),
    };
  };

  it('opens the chapter on the route its via names', () => {
    const href = storylineReadHref({ imageId: 900, chapterId: 60, via: [42, 13, 7] });
    expect(read(href)).toEqual({ path: '/images/900', chapterId: 60, via: [42, 13, 7] });
    expect(href).toContain(`${STORYLINE_VIA_PARAM}=42,13,7`);
  });

  it('carries no via on a route with no rejoin, so the link is the one used everywhere else', () => {
    expect(storylineReadHref({ imageId: 900, chapterId: 3 })).toBe(
      `/images/900?${STORYLINE_CHAPTER_PARAM}=3`
    );
  });
});

describe('storylinePositionLabel', () => {
  it('says the canon path while the reader is on the main route', () => {
    expect(
      storylinePositionLabel({ number: 2, length: 4, path: [{ onMain: true }, { onMain: true }] })
    ).toBe('Chapter 2 of 4 on the canon path');
  });

  it('says this path once any chapter of the reader path is off the main route', () => {
    expect(
      storylinePositionLabel({
        number: 5,
        length: 5,
        path: [{ onMain: true }, { onMain: true }, { onMain: false }, { onMain: false }],
      })
    ).toBe('Chapter 5 of 5 on this path');
    // The count is the line's, whatever it is called.
    expect(storylinePositionLabel({ number: 7, length: 11, path: [{ onMain: false }] })).toBe(
      'Chapter 7 of 11 on this path'
    );
  });

  it('treats a chapter that does not say as on the main route', () => {
    expect(storylinePositionLabel({ number: 1, length: 3, path: [{}, {}] })).toBe(
      'Chapter 1 of 3 on the canon path'
    );
  });

  it('gives only the number while the length is not known', () => {
    expect(
      storylinePositionLabel({ number: 2, length: undefined, path: [{ onMain: false }] })
    ).toBe('Chapter 2');
  });
});
