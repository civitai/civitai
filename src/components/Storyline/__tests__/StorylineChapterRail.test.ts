// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';

const mocks = vi.hoisted(() => ({
  lanes: new Map<number, number>(),
  lanesArgs: vi.fn(),
  jumpToChapter: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylineCanonAhead: () => ({ ahead: [], isSuccess: true }),
  useStorylinePathLanes: (storylineId: number, path: unknown) => {
    mocks.lanesArgs(storylineId, path);
    return mocks.lanes;
  },
}));

import { StorylineChapterRail } from '~/components/Storyline/StorylineChapterRail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chapter = (chapterId: number, depth: number, extra: Record<string, unknown> = {}) => ({
  chapterId,
  depth,
  tombstone: null,
  post: { id: chapterId * 10, title: null, userId: 1, username: 'u' },
  childCount: 1,
  joins: [],
  onMain: true,
  ...extra,
});

// Trunk 1-2, then a branch 3 (a removed chapter) and 4, 5 that the map draws in lanes.
const CHAPTERS = [
  chapter(1, 0),
  chapter(2, 1),
  chapter(3, 2, { onMain: false, tombstone: 'removed', post: null }),
  chapter(4, 3, { onMain: false }),
  chapter(5, 4, { onMain: false }),
];
const IMAGE_CHAPTERS = [1, 1, 2, 3, 4, 4, 5, 5];

function render(index: number) {
  const storyline = {
    active: true,
    path: { storyline: { id: 7 }, chapters: CHAPTERS },
    images: IMAGE_CHAPTERS.map((chapterId, i) => ({ id: i })),
    chapterIdOfImage: (imageId: number) => IMAGE_CHAPTERS[imageId],
    jumpToChapter: mocks.jumpToChapter,
    continueTo: vi.fn(),
  } as unknown as ActiveStorylineMode;
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        null,
        createElement(StorylineChapterRail, {
          storyline,
          images: IMAGE_CHAPTERS.map((_, id) => ({ id })),
          index,
          navigate: mocks.navigate,
        })
      )
    );
  });
  return container;
}

const segment = (container: HTMLElement, chapterId: number) =>
  container.querySelector<HTMLElement>(
    `[data-testid="storyline-rail-segment"][data-chapter-id="${chapterId}"]`
  )!;
const bar = (container: HTMLElement, chapterId: number) =>
  segment(container, chapterId).querySelector<HTMLElement>('button > span')!;

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.lanes = new Map();
  mocks.lanesArgs.mockClear();
  mocks.jumpToChapter.mockClear();
  mocks.navigate.mockClear();
});

describe('StorylineChapterRail path colour', () => {
  it('asks for the lanes of this storyline and this path', () => {
    render(0);
    expect(mocks.lanesArgs.mock.calls[0]).toEqual([7, CHAPTERS]);
  });

  it('draws a path on the main route as it always was: plain bars, no lane', () => {
    const container = render(0);
    for (const id of [2, 4])
      expect(bar(container, id).getAttribute('style') ?? '').not.toContain('mantine-color');
    expect(container.querySelectorAll('[data-lane]')).toHaveLength(0);
    expect(bar(container, 2).className).toContain('bg-white');
  });

  it('colours the chapters of an off-main path in their lane, and the main ones not', () => {
    mocks.lanes = new Map([
      [4, 1],
      [5, 4],
    ]);
    const container = render(0);
    expect(bar(container, 4).style.background).toBe('var(--mantine-color-grape-6)');
    expect(bar(container, 5).style.background).toBe('var(--mantine-color-pink-6)');
    expect(bar(container, 4).className).not.toContain('bg-white');
    expect(segment(container, 5).getAttribute('data-lane')).toBe('4');
    expect(bar(container, 2).style.background).toBe('');
    expect(bar(container, 2).className).toContain('bg-white');
    expect(segment(container, 2).hasAttribute('data-lane')).toBe(false);
  });

  it('keeps a removed chapter grey, whatever lane it was in', () => {
    mocks.lanes = new Map([[3, 1]]);
    const container = render(0);
    expect(bar(container, 3).style.background).toBe('');
    expect(bar(container, 3).className).toContain('bg-gray-6');
  });

  it('rings the current chapter in its lane colour', () => {
    mocks.lanes = new Map([[4, 1]]);
    const container = render(4);
    const ring = segment(container, 4).querySelector<HTMLElement>('[role="group"]')!;
    expect(ring.getAttribute('style')).toContain('--tw-ring-color: var(--mantine-color-grape-6)');
    expect(segment(render(0), 1).querySelector('[role="group"]')?.getAttribute('style')).toBeNull();
  });

  it('still jumps to a coloured chapter, and ticks still move between its images', () => {
    mocks.lanes = new Map([[4, 1]]);
    const container = render(4);
    act(() => segment(container, 5).querySelector<HTMLElement>('button')!.click());
    expect(mocks.jumpToChapter.mock.calls).toEqual([[5]]);
    const ticks = segment(container, 4).querySelectorAll<HTMLElement>(
      '[data-testid="storyline-rail-tick"]'
    );
    expect(ticks).toHaveLength(2);
    act(() => ticks[1].click());
    expect(mocks.navigate.mock.calls).toEqual([[5]]);
  });
});
