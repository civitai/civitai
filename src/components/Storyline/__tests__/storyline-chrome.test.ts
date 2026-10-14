// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import { StorylineMapControl } from '~/components/Storyline/StorylineMap';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import {
  StorylineEntryChip,
  StorylineModeChip,
  StorylinePill,
} from '~/components/Storyline/StorylinePill';

const mocks = vi.hoisted(() => ({
  pathChildren: new Map<number, unknown[]>(),
  ahead: [] as unknown[],
  aheadLoading: false,
  shares: undefined as undefined | { total: number; shares: Record<number, number> },
  mobile: false,
}));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylinePathChildren: () => mocks.pathChildren,
  useStorylineCanonAhead: () => ({
    ahead: mocks.ahead,
    childrenByChapterId: new Map(),
    isLoading: mocks.aheadLoading,
  }),
  useStorylineForkShares: () => ({ data: mocks.shares }),
}));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => mocks.mobile }));

function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(MantineProvider, { forceColorScheme: 'light', env: 'test' }, element)
    );
  });
  return container;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.pathChildren = new Map();
  mocks.ahead = [];
  mocks.aheadLoading = false;
  mocks.shares = undefined;
  mocks.mobile = false;
});

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s/g, ' ');
const q = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls;
const chapter = (chapterId: number, depth: number, title: string | null = `Ch ${chapterId}`) => ({
  chapterId,
  depth,
  tombstone: title === null ? 'removed' : null,
  post: title === null ? null : { id: chapterId * 10, title, userId: 3, username: 'u' },
});

function renderMap({ chapterIds = [1], current = chapterIds[0], open = true } = {}) {
  const storyline = {
    path: {
      storyline: { id: 2, title: 'The Patch' },
      chapters: chapterIds.map((id, depth) => chapter(id, depth)),
    },
    drawerOpen: open,
    setDrawerOpen: vi.fn(),
    jumpToChapter: vi.fn(),
    continueTo: vi.fn(),
    leave: vi.fn(),
  } as unknown as ActiveStorylineMode;
  const depth = chapterIds.indexOf(current);
  render(createElement(StorylineMapControl, { storyline, currentChapterId: current, depth }));
  return storyline;
}

const branch = (chapterId: number) => ({
  ...chapter(chapterId, 1, `Way ${chapterId}`),
  rank: 'community',
});

describe('StorylinePill', () => {
  it('names the storyline and the chapter, not the word Storyline', () => {
    const c = render(createElement(StorylinePill, { title: 'The Patch', depth: 2 }));
    // The separator sits after a no-break space, so it never starts a line of its own.
    expect(text(c.querySelector('[data-testid="storyline-pill"]'))).toBe('The Patch · Ch 3');
  });

  it('truncates only the title, so the chapter stays readable', () => {
    const c = render(createElement(StorylinePill, { title: 'A'.repeat(200), depth: 0 }));
    const title = c.querySelector('[data-testid="storyline-pill-title"]');
    expect([
      title?.classList.contains('truncate'),
      title?.nextElementSibling?.classList.contains('shrink-0'),
    ]).toEqual([true, true]);
  });
});

describe('StorylineModeChip', () => {
  function renderChip(mapOpen = false) {
    const onToggleMap = vi.fn();
    const c = render(
      createElement(StorylineModeChip, { title: 'The Patch', depth: 3, mapOpen, onToggleMap })
    );
    return { c, chip: q('storyline-mode-chip'), onToggleMap };
  }

  // No "of M": the path's length reads as the story ending at a fork. The map carries the length.
  it('names the storyline and the chapter, with no total', () => {
    const { chip } = renderChip();
    expect(text(chip)).toBe('The Patch · Ch 4');
  });

  it('says whether the map is open', () => {
    expect(renderChip(false).chip?.getAttribute('aria-expanded')).toBe('false');
    document.body.innerHTML = '';
    expect(renderChip(true).chip?.getAttribute('aria-expanded')).toBe('true');
  });

  // Sunita, 2026-10-14: the chip has no x. Leaving lives at the foot of the map sheet, and closing
  // the image leaves too. Do not put a second control back on the chip.
  it('is one button that toggles the map, with no leave control of its own', () => {
    const { c, chip, onToggleMap } = renderChip(true);
    act(() => chip?.click());
    expect([
      chip?.tagName,
      c.querySelectorAll('button').length,
      onToggleMap.mock.calls.length,
    ]).toEqual(['BUTTON', 1, 1]);
  });
});

describe('StorylineEntryChip', () => {
  it('invites reading the story from this chapter', () => {
    const onEnter = vi.fn();
    const c = render(createElement(StorylineEntryChip, { title: 'The Patch', depth: 3, onEnter }));
    const chip = c.querySelector<HTMLElement>('[data-testid="storyline-enter"]');
    expect(text(chip)).toBe('The Patch · Ch 4Read the story');
    act(() => chip?.click());
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});

describe('the map on desktop: a sheet that drops from the chip', () => {
  it('opens under the chip with nothing covering the page, named by its title', () => {
    renderMap();
    const sheet = q('storyline-map-sheet');
    expect([
      !!sheet,
      !!document.body.querySelector('.mantine-Drawer-overlay, .mantine-Overlay-root'),
      q('storyline-mode-chip')?.getAttribute('aria-expanded'),
      sheet?.getAttribute('aria-labelledby') === q('storyline-map-title')?.id,
    ]).toEqual([true, false, 'true', true]);
  });

  it('closes from the chip, the close button, Esc and a press outside, not a press inside', () => {
    const storyline = renderMap();
    act(() => q('storyline-subway')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(calls(storyline.setDrawerOpen)).toEqual([]);
    act(() => q('storyline-mode-chip')?.click());
    act(() => q('storyline-map-close')?.click());
    act(() => {
      q('storyline-map-sheet')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(calls(storyline.setDrawerOpen)).toEqual([[false], [false], [false], [false]]);
  });

  it('opens from the chip, and shows no sheet while closed', () => {
    const storyline = renderMap({ open: false });
    expect([q('storyline-map-sheet'), q('storyline-mode-chip')?.getAttribute('aria-expanded')]).toEqual(
      [null, 'false']
    );
    act(() => q('storyline-mode-chip')?.click());
    expect(calls(storyline.setDrawerOpen)).toEqual([[true]]);
  });
});

describe('the map on a phone: a bottom sheet that does not dim the page', () => {
  it('opens as a drawer with no overlay, not as the desktop sheet', () => {
    mocks.mobile = true;
    renderMap();
    expect([
      !!q('storyline-subway'),
      !!q('storyline-map-sheet'),
      !!document.body.querySelector('.mantine-Drawer-content'),
      !!document.body.querySelector('.mantine-Drawer-overlay, .mantine-Overlay-root'),
      !!q('storyline-mode-chip'),
    ]).toEqual([true, false, true, false, true]);
  });
});

describe('the map', () => {
  it('names the storyline and where the reader is on the canon path', () => {
    mocks.ahead = [chapter(3, 2), chapter(4, 3)];
    renderMap({ chapterIds: [1, 2], current: 2 });
    expect([text(q('storyline-map-title')), text(q('storyline-map-position'))]).toEqual([
      'The Patch',
      'Chapter 2 of 4 on the canon path',
    ]);
  });

  it('gives no total while the canon path is still being read', () => {
    mocks.aheadLoading = true;
    renderMap({ chapterIds: [1, 2], current: 2 });
    expect(text(q('storyline-map-position'))).toBe('Chapter 2');
  });

  it('marks where the reader is', () => {
    renderMap({ chapterIds: [1, 2], current: 2 });
    const stops = [...document.body.querySelectorAll('[data-testid="storyline-stop"]')];
    expect(stops.map((s) => s.getAttribute('aria-current'))).toEqual([null, 'step']);
    expect(stops[1].textContent).toContain('YOU ARE HERE');
  });

  it('reads on to the next chapter of the path from the footer', () => {
    mocks.ahead = [chapter(3, 2)];
    const storyline = renderMap({ chapterIds: [1, 2], current: 1 });
    expect(text(q('storyline-map-read-next'))).toBe('Read chapter 2');
    act(() => q('storyline-map-read-next')?.click());
    expect([calls(storyline.jumpToChapter), calls(storyline.continueTo)]).toEqual([[[2]], []]);
  });

  it('continues onto the canon path ahead from the footer at the end of the path', () => {
    mocks.ahead = [chapter(3, 2)];
    const storyline = renderMap({ chapterIds: [1, 2], current: 2 });
    expect(text(q('storyline-map-read-next'))).toBe('Read chapter 3');
    act(() => q('storyline-map-read-next')?.click());
    expect([
      calls(storyline.jumpToChapter),
      calls(storyline.continueTo).map(([c, o]) => [c.chapterId, o]),
    ]).toEqual([[], [[3, { track: false }]]]);
  });

  it('links to the story page, and has no Read when there is nothing after', () => {
    renderMap();
    expect([
      q('storyline-map-story-page')?.getAttribute('href'),
      q('storyline-map-read-next'),
    ]).toEqual(['/storylines/2', null]);
  });

  it('leaves the storyline from the foot of the sheet', () => {
    const storyline = renderMap();
    act(() => q('storyline-leave')?.click());
    expect([calls(storyline.leave).length, text(q('storyline-leave'))]).toEqual([
      1,
      "Leave the storyline · browse this post's images",
    ]);
  });

  it('shows the share of each way off the end from the first choice', () => {
    mocks.pathChildren = new Map([[1, [branch(2), branch(3)]]]);
    mocks.shares = { total: 4, shares: { 2: 0.75 } };
    renderMap();
    const rows = [...document.body.querySelectorAll('[data-testid="storyline-branch"]')];
    expect(
      rows.map((r) => [
        r.querySelector('[data-testid="storyline-branch-name"]')?.textContent,
        r.querySelector('[data-testid="storyline-branch-share"]')?.textContent,
      ])
    ).toEqual([
      ['Way 2', '75%'],
      ['Way 3', '0%'],
    ]);
    expect(q('storyline-shares-pending')).toBeNull();
  });

  it('shows shares only where the path ends, not on branches left behind', () => {
    mocks.pathChildren = new Map([
      [1, [branch(2), branch(5)]],
      [2, [branch(3)]],
    ]);
    mocks.shares = { total: 4, shares: { 3: 1 } };
    renderMap({ chapterIds: [1, 2] });
    const rows = [...document.body.querySelectorAll('[data-testid="storyline-branch"]')];
    expect(
      rows.map((r) => r.querySelector('[data-testid="storyline-branch-share"]')?.textContent ?? null)
    ).toEqual([null, '100%']);
  });

  it('takes a branch from where it forks', () => {
    mocks.pathChildren = new Map([[1, [branch(2)]]]);
    const storyline = renderMap();
    act(() => q('storyline-branch')?.click());
    expect(calls(storyline.continueTo).map(([c, o]) => [c.chapterId, o])).toEqual([
      [2, { from: 1 }],
    ]);
  });

  it('invites the first choice when nobody has chosen', () => {
    mocks.pathChildren = new Map([[1, [branch(2)]]]);
    mocks.shares = { total: 0, shares: {} };
    renderMap();
    expect([
      q('storyline-shares-pending')?.textContent,
      q('storyline-branch-share'),
    ]).toEqual(['Be the first to choose', null]);
  });
});
