// @vitest-environment happy-dom
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import type * as RouterModule from '~/components/BrowserRouter/BrowserRouterProvider';
import type { StorylinePathChapter } from '~/server/services/storyline.service';

type Chapter = StorylinePathChapter;
type Image = { id: number; postId: number; index: number };

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    query: {} as Record<string, unknown>,
    asPath: '/images/1',
    replace: vi.fn(),
    trackBranchChoice: vi.fn(),
    hiddenUserIds: new Set<number>(),
    paths: {} as Record<number, Chapter[]>,
    /** Images by post id; a post absent here has no image this reader can see. */
    imagesByPost: {} as Record<number, Image[]>,
    imagesFetching: false,
    /** Chapter whose path read still shows another chapter's data (keepPreviousData). */
    placeholder: {} as Record<number, number>,
    pathVia: undefined as number[] | undefined,
    bump: () => undefined as void,
  };
});

// A router whose replace actually moves the URL, so the provider sees its own navigations.
vi.mock('~/components/BrowserRouter/BrowserRouterProvider', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react');
  let version = 0;
  const subscribe = (fn: () => void) => {
    mocks.listeners.add(fn);
    return () => mocks.listeners.delete(fn);
  };
  mocks.bump = () => {
    version++;
    mocks.listeners.forEach((fn) => fn());
  };
  return {
    ...(await importOriginal<typeof RouterModule>()),
    useBrowserRouter: () => {
      useSyncExternalStore(subscribe, () => version);
      return {
        query: mocks.query,
        asPath: mocks.asPath,
        replace: (url: { query: Record<string, unknown> }, as: { pathname: string }) => {
          mocks.replace(url.query, as.pathname);
          mocks.query = { ...url.query };
          mocks.asPath = as.pathname;
          version++;
          mocks.listeners.forEach((fn) => fn());
        },
      };
    },
  };
});

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylinesEnabled: () => true,
  useHiddenUserIds: () => mocks.hiddenUserIds,
  useStorylineTracking: () => ({
    trackBranchChoice: mocks.trackBranchChoice,
    trackCreateClick: vi.fn(),
  }),
  useStorylinePath: (requested: number | undefined, via?: number[]) => {
    mocks.pathVia = via;
    const chapterId = (requested && mocks.placeholder[requested]) || requested;
    return {
      data:
        chapterId && mocks.paths[chapterId]
          ? {
              storyline: { id: 1, title: 'The Patch', userId: 1, maxNsfwLevel: 1 },
              chapters: mocks.paths[chapterId],
              hasEarlier: false,
            }
          : undefined,
      isLoading: false,
    };
  },
  useStorylinePathImages: (chapters: Chapter[] | undefined) => ({
    images: (chapters ?? []).flatMap((c) => (c.post ? mocks.imagesByPost[c.post.id] ?? [] : [])),
    isLoading: false,
    isFetching: mocks.imagesFetching,
  }),
}));

vi.mock('~/components/PageLoader/PageLoader', () => ({ PageLoader: () => null }));

import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import {
  StorylineModeProvider,
  useStorylineMode,
} from '~/components/Storyline/StorylineModeProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chapter = (chapterId: number, depth: number, postId: number, userId = 1): Chapter => ({
  chapterId,
  depth,
  tombstone: null,
  post: { id: postId, title: `ch${depth + 1}`, userId, username: `u${userId}` },
});
const tombstone = (chapterId: number, depth: number): Chapter => ({
  chapterId,
  depth,
  tombstone: 'browsingLevel',
  post: null,
});

let mode: ReturnType<typeof useStorylineMode>;
let walkedImageIds: number[] | undefined;
function Probe() {
  mode = useStorylineMode();
  return null;
}

const roots: Root[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
});

function open(imageId: number, storylineChapter: number) {
  mocks.query = { imageId, storylineChapter };
  mocks.asPath = `/images/${imageId}?storylineChapter=${storylineChapter}`;
  const container = document.createElement('div');
  act(() => {
    const root = createRoot(container);
    roots.push(root);
    root.render(
      createElement(StorylineModeProvider, null, (images: Image[] | undefined) => {
        walkedImageIds = images?.map((i) => i.id);
        return createElement(Probe);
      })
    );
  });
}
const active = () => mode as ActiveStorylineMode;
function moveUrl(query: Record<string, unknown>) {
  act(() => {
    mocks.query = query;
    mocks.bump();
  });
}

// 1 -> 2 -> 3 on the main line; 2 also forks to 9, which this reader cannot see.
beforeEach(() => {
  mocks.replace.mockClear();
  mocks.trackBranchChoice.mockClear();
  mocks.hiddenUserIds = new Set();
  mocks.imagesFetching = false;
  mocks.placeholder = {};
  mocks.paths = {
    3: [chapter(1, 0, 100), chapter(2, 1, 200), chapter(3, 2, 300)],
    4: [chapter(1, 0, 100), chapter(2, 1, 200), chapter(3, 2, 300), chapter(4, 3, 400)],
    9: [chapter(1, 0, 100), chapter(2, 1, 200), tombstone(9, 2)],
    77: [chapter(77, 0, 700)],
  };
  mocks.imagesByPost = {
    100: [{ id: 10, postId: 100, index: 0 }],
    200: [{ id: 20, postId: 200, index: 0 }],
    300: [{ id: 30, postId: 300, index: 0 }],
    400: [
      { id: 40, postId: 400, index: 0 },
      { id: 41, postId: 400, index: 1 },
    ],
    700: [{ id: 70, postId: 700, index: 0 }],
  };
});

describe('StorylineModeProvider', () => {
  it('walks the path when the open image is on it', () => {
    open(20, 3);
    expect(mode.active).toBe(true);
    expect(walkedImageIds).toEqual([10, 20, 30]);
  });

  it('stays off for a link pairing an image with a storyline it is not part of', () => {
    open(70, 3);
    expect(mode.active).toBe(false);
    expect(walkedImageIds).toBeUndefined();
  });

  it("shows a hidden user's chapter as unavailable, not by name", () => {
    mocks.paths[3] = [chapter(1, 0, 100), chapter(2, 1, 200, 7), chapter(3, 2, 300)];
    mocks.hiddenUserIds = new Set([7]);
    open(10, 3);
    expect(active().path.chapters.map((c) => c.tombstone)).toEqual([null, 'unavailable', null]);
  });

  it('taking a branch opens its first image and records the choice', () => {
    open(30, 3);
    act(() => active().continueTo({ chapterId: 4 }));
    expect(mocks.trackBranchChoice.mock.calls).toEqual([[{ fromChapterId: 3, toChapterId: 4 }]]);
    expect(mocks.replace).toHaveBeenLastCalledWith(
      expect.objectContaining({ imageId: 40, storylineChapter: 4 }),
      '/images/40'
    );
    expect(active().chapterId).toBe(4);
  });

  it('carries the way in to a chapter where branches rejoin, and reads its path that way', () => {
    open(30, 3);
    act(() => active().continueTo({ chapterId: 4, parentCount: 2 }));
    expect(mocks.replace).toHaveBeenLastCalledWith(
      expect.objectContaining({ imageId: 40, storylineChapter: 4, storylineVia: '3' }),
      '/images/40'
    );
    expect(mocks.pathVia).toEqual([3]);
  });

  it('adds no way in for a chapter with one parent, so its links stay as they were', () => {
    open(30, 3);
    act(() => active().continueTo({ chapterId: 4, parentCount: 1 }));
    expect(mocks.replace.mock.calls.at(-1)?.[0]).not.toHaveProperty('storylineVia');
    expect(mocks.pathVia).toEqual([]);
  });

  it('waits for the branch images before opening one', () => {
    open(30, 3);
    mocks.imagesFetching = true;
    act(() => active().continueTo({ chapterId: 4 }));
    expect(mocks.replace).toHaveBeenCalledTimes(1); // only the chapter move, no image yet
    mocks.imagesFetching = false;
    moveUrl({ ...mocks.query });
    expect(mocks.replace).toHaveBeenLastCalledWith(
      expect.objectContaining({ imageId: 40 }),
      '/images/40'
    );
  });

  it('a hidden branch taken from mid-path opens its end view, and closing it keeps the reader in the storyline', () => {
    open(30, 3);
    act(() => active().continueTo({ chapterId: 9 }));
    expect(active().endOpen).toBe(true);
    expect(active().chapterId).toBe(9);
    act(() => active().setEndOpen(false));
    // Image 30 is not on the new path; the reader got here from inside the storyline.
    expect(mode.active).toBe(true);
  });

  it('an end view does not carry over to a chapter the URL moves to by other means', () => {
    open(30, 3);
    act(() => active().continueTo({ chapterId: 9 }));
    expect(active().endOpen).toBe(true);
    // e.g. history back to an old link pairing image 30 with an unrelated storyline
    moveUrl({ imageId: 30, storylineChapter: 77 });
    expect(mode.active).toBe(false);
  });

  it('an end view closes when the URL moves to another chapter the reader is on', () => {
    open(30, 3);
    act(() => active().continueTo({ chapterId: 9 }));
    expect(active().endOpen).toBe(true);
    moveUrl({ imageId: 20, storylineChapter: 4 });
    expect(mode.active).toBe(true);
    expect(active().endOpen).toBe(false);
  });

  it("does not trust a chapter on the strength of the previous chapter's data", () => {
    open(30, 3);
    // Chapter 77's read still shows chapter 3's path, which image 30 is on.
    mocks.placeholder = { 77: 3 };
    moveUrl({ imageId: 30, storylineChapter: 77 });
    expect(mode.active).toBe(false);
    mocks.placeholder = {};
    moveUrl({ imageId: 30, storylineChapter: 77 });
    expect(mode.active).toBe(false);
  });

  it('trust from taking a branch covers the image the reader was on, not any other', () => {
    open(30, 3);
    act(() => active().continueTo({ chapterId: 9 }));
    expect(mode.active).toBe(true);
    moveUrl({ imageId: 70, storylineChapter: 9 });
    expect(mode.active).toBe(false);
  });

  it('jumping to a chapter opens its first image and closes the end view and drawer', () => {
    open(30, 3);
    act(() => {
      active().setEndOpen(true);
      active().setDrawerOpen(true);
    });
    act(() => active().jumpToChapter(1));
    expect(mocks.replace).toHaveBeenLastCalledWith(
      expect.objectContaining({ imageId: 10, storylineChapter: 3 }),
      '/images/10'
    );
    expect([active().endOpen, active().drawerOpen]).toEqual([false, false]);
  });

  it('a branch taken from an earlier stop is recorded against that stop and keeps the reader in while it loads', () => {
    open(30, 3);
    mocks.imagesFetching = true;
    act(() => active().continueTo({ chapterId: 9 }, { from: 2 }));
    // Image 30 is not on 9's path, and the branch has not resolved yet.
    expect(mode.active).toBe(true);
    expect(mocks.trackBranchChoice.mock.calls).toEqual([[{ fromChapterId: 2, toChapterId: 9 }]]);
  });

  it('a jump along the canon line is not recorded as a choice at a fork', () => {
    open(30, 3);
    act(() => active().continueTo({ chapterId: 4 }, { track: false }));
    expect(mocks.trackBranchChoice).not.toHaveBeenCalled();
  });

  it('leaving drops the chapter from the URL and closes the end view', () => {
    open(30, 3);
    act(() => active().setEndOpen(true));
    act(() => active().leave());
    const [query] = mocks.replace.mock.lastCall ?? [];
    expect(query).not.toHaveProperty('storylineChapter');
    expect(mode.active).toBe(false);
  });
});
