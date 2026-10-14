// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import { StorylineDrawer } from '~/components/Storyline/StorylineDrawer';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { StorylinePill } from '~/components/Storyline/StorylinePill';

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylinePathChildren: () => new Map(),
  useStorylineCanonAhead: () => ({ ahead: [], childrenByChapterId: new Map(), isLoading: false }),
  useStorylineForkShares: () => ({ data: undefined }),
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
});

describe('StorylinePill', () => {
  it('names the storyline and the chapter, not the word Storyline', () => {
    const c = render(createElement(StorylinePill, { title: 'The Patch', depth: 2 }));
    expect(c.querySelector('[data-testid="storyline-pill"]')?.textContent).toBe('The Patch · ch 3');
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
    expect(overlay?.style.getPropertyValue('--overlay-bg')).toBe('rgba(0, 0, 0, 0)');
  });
});
