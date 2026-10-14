// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import { StorylineDrawer } from '~/components/Storyline/StorylineDrawer';
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
const chapter = (chapterId: number, depth: number, title: string | null = `Ch ${chapterId}`) => ({
  chapterId,
  depth,
  tombstone: title === null ? 'removed' : null,
  post: title === null ? null : { id: chapterId * 10, title, userId: 3, username: 'u' },
});

function openMap({ chapterIds = [1], current = chapterIds[0] } = {}) {
  const storyline = {
    path: {
      storyline: { id: 2, title: 'The Patch' },
      chapters: chapterIds.map((id, depth) => chapter(id, depth)),
    },
    drawerOpen: true,
    setDrawerOpen: vi.fn(),
    jumpToChapter: vi.fn(),
    continueTo: vi.fn(),
    leave: vi.fn(),
  } as unknown as ActiveStorylineMode;
  render(createElement(StorylineDrawer, { storyline, currentChapterId: current }));
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
    return { chip: c.querySelector('[data-testid="storyline-mode-chip"]'), onToggleMap };
  }

  // No "of M": the path's length reads as the story ending at a fork. The map carries the length.
  it('names the storyline and the chapter, with no total', () => {
    const { chip } = renderChip();
    expect(text(chip?.querySelector('[data-testid="storyline-pill"]'))).toBe('The Patch · Ch 4');
  });

  // Justin chose no x on the chip: leaving lives in the map's header.
  it('toggles the map and has no leave control of its own', () => {
    const { chip, onToggleMap } = renderChip(true);
    const pill = chip?.querySelector<HTMLElement>('[data-testid="storyline-pill"]');
    expect(pill?.getAttribute('aria-expanded')).toBe('true');
    act(() => pill?.click());
    expect([onToggleMap.mock.calls.length, chip?.querySelectorAll('button').length]).toEqual([
      1, 1,
    ]);
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

describe('the map on desktop: a flyout with no backdrop', () => {
  it('opens beside the image with nothing covering the page', () => {
    openMap();
    expect([
      !!q('storyline-map-flyout'),
      !!document.body.querySelector('.mantine-Drawer-overlay, .mantine-Overlay-root'),
    ]).toEqual([true, false]);
  });

  it('tucks back on Esc and on a press outside it, but not on a press inside it', () => {
    const storyline = openMap();
    act(() => q('storyline-subway')?.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(storyline.setDrawerOpen).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect((storyline.setDrawerOpen as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [false],
      [false],
    ]);
  });

  it('leaves the press on the chip to the chip, which toggles the map itself', () => {
    const storyline = openMap();
    const chip = document.createElement('div');
    chip.setAttribute('data-storyline-map-keep', '');
    document.body.appendChild(chip);
    act(() => chip.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(storyline.setDrawerOpen).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    const storyline = {
      path: { storyline: { id: 2, title: 'The Patch' }, chapters: [chapter(1, 0)] },
      drawerOpen: false,
      setDrawerOpen: vi.fn(),
    } as unknown as ActiveStorylineMode;
    render(createElement(StorylineDrawer, { storyline, currentChapterId: 1 }));
    expect(q('storyline-map-flyout')).toBeNull();
  });
});

describe('the map on a phone: a bottom sheet that does not dim the page', () => {
  it('opens as a sheet with no overlay', () => {
    mocks.mobile = true;
    openMap();
    expect([
      !!q('storyline-subway'),
      !!q('storyline-map-flyout'),
      !!document.body.querySelector('.mantine-Drawer-overlay'),
    ]).toEqual([true, false, false]);
  });
});

describe('the map', () => {
  it('names the storyline and where the reader is on the canon line', () => {
    mocks.ahead = [chapter(3, 2), chapter(4, 3)];
    openMap({ chapterIds: [1, 2], current: 2 });
    expect([text(q('storyline-map-title')), text(q('storyline-map-position'))]).toEqual([
      'The Patch',
      'Chapter 2 of 4',
    ]);
  });

  it('gives no total while the canon line is still being read', () => {
    mocks.aheadLoading = true;
    openMap({ chapterIds: [1, 2], current: 2 });
    expect(text(q('storyline-map-position'))).toBe('Chapter 2');
  });

  it('marks where the reader is', () => {
    openMap({ chapterIds: [1, 2], current: 2 });
    const stops = [...document.body.querySelectorAll('[data-testid="storyline-stop"]')];
    expect(stops.map((s) => s.getAttribute('aria-current'))).toEqual([null, 'step']);
    expect(stops[1].textContent).toContain('YOU ARE HERE');
  });

  it('reads on to the next chapter from the footer', () => {
    mocks.ahead = [chapter(3, 2)];
    const storyline = openMap({ chapterIds: [1, 2], current: 1 });
    expect(text(q('storyline-map-read-next'))).toBe('Read chapter 2');
    act(() => q('storyline-map-read-next')?.click());
    expect((storyline.jumpToChapter as ReturnType<typeof vi.fn>).mock.calls).toEqual([[2]]);
  });

  it('continues onto the canon line ahead from the footer at the end of the path', () => {
    mocks.ahead = [chapter(3, 2)];
    const storyline = openMap({ chapterIds: [1, 2], current: 2 });
    act(() => q('storyline-map-read-next')?.click());
    expect(
      (storyline.continueTo as ReturnType<typeof vi.fn>).mock.calls.map(([c, o]) => [
        c.chapterId,
        o,
      ])
    ).toEqual([[3, { track: false }]]);
  });

  it('links to the story page, and has no Read when there is nothing after', () => {
    openMap();
    expect([
      q('storyline-map-story-page')?.getAttribute('href'),
      q('storyline-map-read-next'),
    ]).toEqual(['/storylines/2', null]);
  });

  it('leaves the storyline from its header', () => {
    const storyline = openMap();
    act(() => q('storyline-leave')?.click());
    expect(storyline.leave).toHaveBeenCalledTimes(1);
  });

  it('shows the share of each way off the end from the first choice', () => {
    mocks.pathChildren = new Map([[1, [branch(2), branch(3)]]]);
    mocks.shares = { total: 4, shares: { 2: 0.75 } };
    openMap();
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
    openMap({ chapterIds: [1, 2] });
    const rows = [...document.body.querySelectorAll('[data-testid="storyline-branch"]')];
    expect(
      rows.map((r) => r.querySelector('[data-testid="storyline-branch-share"]')?.textContent ?? null)
    ).toEqual([null, '100%']);
  });

  it('invites the first choice when nobody has chosen', () => {
    mocks.pathChildren = new Map([[1, [branch(2)]]]);
    mocks.shares = { total: 0, shares: {} };
    openMap();
    expect([
      q('storyline-shares-pending')?.textContent,
      q('storyline-branch-share'),
    ]).toEqual(['Be the first to choose', null]);
  });
});
