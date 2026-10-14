// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import { StorylineDrawer } from '~/components/Storyline/StorylineDrawer';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { StorylinePill } from '~/components/Storyline/StorylinePill';

const mocks = vi.hoisted(() => ({
  pathChildren: new Map<number, unknown[]>(),
  shares: undefined as undefined | { total: number; shares: Record<number, number> },
}));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylinePathChildren: () => mocks.pathChildren,
  useStorylineCanonAhead: () => ({ ahead: [], childrenByChapterId: new Map(), isLoading: false }),
  useStorylineForkShares: () => ({ data: mocks.shares }),
}));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

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
  mocks.shares = undefined;
});

function openDrawer() {
  const storyline = {
    path: {
      storyline: { id: 2, title: 'The Patch' },
      chapters: [{ chapterId: 1, depth: 0, post: null, tombstone: null }],
    },
    drawerOpen: true,
    setDrawerOpen: vi.fn(),
    jumpToChapter: vi.fn(),
    continueTo: vi.fn(),
  } as unknown as ActiveStorylineMode;
  render(createElement(StorylineDrawer, { storyline, currentChapterId: 1 }));
  return storyline;
}

const branch = (chapterId: number) => ({
  chapterId,
  depth: 1,
  rank: 'community',
  tombstone: null,
  post: { id: chapterId * 10, title: `Way ${chapterId}`, userId: 3, username: 'u' },
});

describe('StorylinePill', () => {
  it('names the storyline and the chapter, not the word Storyline', () => {
    const c = render(createElement(StorylinePill, { title: 'The Patch', depth: 2 }));
    const text = c.querySelector('[data-testid="storyline-pill"]')?.textContent;
    // The separator sits after a no-break space, so it never starts a line of its own.
    expect(text?.replace(/\s/g, ' ')).toBe('The Patch · ch 3');
  });

  it('truncates only the title, so the chapter stays readable', () => {
    const c = render(createElement(StorylinePill, { title: 'A'.repeat(200), depth: 0 }));
    const title = c.querySelector('[data-testid="storyline-pill-title"]');
    expect([title?.className, title?.nextElementSibling?.className]).toEqual([
      'truncate',
      'shrink-0',
    ]);
  });
});

describe('StorylineDrawer', () => {
  it('does not gray out the page behind it', () => {
    const storyline = {
      path: {
        storyline: { id: 2, title: 'The Patch' },
        chapters: [{ chapterId: 1, depth: 0, post: null, tombstone: null }],
      },
      drawerOpen: true,
      setDrawerOpen: vi.fn(),
      jumpToChapter: vi.fn(),
      continueTo: vi.fn(),
    } as unknown as ActiveStorylineMode;
    render(createElement(StorylineDrawer, { storyline, currentChapterId: 1 }));
    const overlay = document.body.querySelector<HTMLElement>('.mantine-Drawer-overlay');
    expect(overlay).not.toBeNull();
    expect([
      overlay?.style.getPropertyValue('--overlay-bg'),
      overlay?.style.getPropertyValue('--overlay-filter'),
    ]).toEqual(['rgba(0, 0, 0, 0)', '']);
    act(() => overlay?.click());
    expect(storyline.setDrawerOpen).toHaveBeenCalledWith(false);
  });

  it('shows the share of each way off the end from the first choice', () => {
    mocks.pathChildren = new Map([[1, [branch(2), branch(3)]]]);
    mocks.shares = { total: 4, shares: { 2: 0.75 } };
    openDrawer();
    const rows = [...document.body.querySelectorAll('[data-testid="storyline-branch"]')];
    expect(rows.map((r) => r.textContent)).toEqual(['Way 275%', 'Way 30%']);
    expect(document.body.querySelector('[data-testid="storyline-shares-pending"]')).toBeNull();
  });

  it('invites the first choice when nobody has chosen', () => {
    mocks.pathChildren = new Map([[1, [branch(2)]]]);
    mocks.shares = { total: 0, shares: {} };
    openDrawer();
    expect(
      document.body.querySelector('[data-testid="storyline-shares-pending"]')?.textContent
    ).toBe('Be the first to choose');
    expect(document.body.querySelector('[data-testid="storyline-branch"]')?.textContent).toBe(
      'Way 2'
    );
  });
});
