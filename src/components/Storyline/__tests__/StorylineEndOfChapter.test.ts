// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import type { StorylineChild } from '~/components/Storyline/storyline.queries';

const mocks = vi.hoisted(() => ({
  children: [] as StorylineChild[],
  forkShares: { enough: false, total: 0, minChoices: 20, shares: {} as Record<number, number> },
  trackCreateClick: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylineChildren: () => ({ data: mocks.children, isLoading: false }),
  useStorylineForkShares: () => ({ data: mocks.forkShares }),
  useStorylineTracking: () => ({
    trackBranchChoice: vi.fn(),
    trackCreateClick: mocks.trackCreateClick,
  }),
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: mocks.trigger } }));
vi.mock('~/components/Storyline/StorylineEarlyAccessModal', () => ({
  StorylineEarlyAccessModal: () => null,
}));

import { MantineProvider } from '@mantine/core';
import { StorylineEndOfChapter } from '~/components/Storyline/StorylineEndOfChapter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function child(
  chapterId: number,
  rank: StorylineChild['rank'],
  title: string | null
): StorylineChild {
  return title === null
    ? { chapterId, depth: 4, tombstone: 'removed', post: null, rank, createdAt: new Date(0) }
    : {
        chapterId,
        depth: 4,
        tombstone: null,
        post: { id: chapterId * 10, title, userId: chapterId, username: `user${chapterId}` },
        rank,
        createdAt: new Date(0),
      };
}

let onContinue = vi.fn();
function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        { forceColorScheme: 'light' },
        createElement(StorylineEndOfChapter, { chapterId: 4, storylineId: 9, onContinue })
      )
    );
  });
  return container;
}

const forks = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="storyline-fork"]'),
];

describe('StorylineEndOfChapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.forkShares = { enough: false, total: 0, minChoices: 20, shares: {} };
    mocks.trackCreateClick.mockClear();
    mocks.trigger.mockClear();
    onContinue = vi.fn();
  });

  it('keeps the server order and makes only the first fork the main path', () => {
    mocks.children = [
      child(5, 'canon', 'The thrift store closes down'),
      child(6, 'endorsed', 'A museum buys the frame'),
      child(7, 'community', 'Video: the cat comes back'),
    ];
    const container = render();
    const cards = forks(container);
    expect(cards.map((c) => c.dataset.rank)).toEqual(['canon', 'endorsed', 'community']);
    // Only the main path carries the inline Read button.
    expect(cards.map((c) => c.textContent?.includes('Read'))).toEqual([true, false, false]);

    act(() => cards[1].click());
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ chapterId: 6 }));
  });

  it('shows a removed continuation as a tombstone instead of failing on its missing post', () => {
    mocks.children = [child(5, 'canon', 'Kept'), child(8, 'community', null)];
    const container = render();
    expect(forks(container)[1].textContent).toContain('This chapter was removed');
  });

  it('shows every fork with its share once enough readers have chosen', () => {
    mocks.children = [child(5, 'canon', 'Kept'), child(6, 'community', 'Other')];
    mocks.forkShares = { enough: true, total: 40, minChoices: 20, shares: { 5: 0.73 } };
    const container = render();
    const [main, other] = forks(container);
    expect(main.textContent).toContain('73% of readers');
    // A fork nobody has taken yet reads 0%, not blank, once the split is shown.
    expect(other.textContent).toContain('0% of readers');
    expect(container.querySelector('[data-testid="storyline-shares-pending"]')).toBeNull();
  });

  it('shows no percentages and says how far off the threshold is when too few have chosen', () => {
    mocks.children = [child(5, 'canon', 'Kept'), child(6, 'community', 'Other')];
    mocks.forkShares = { enough: false, total: 3, minChoices: 20, shares: {} };
    const container = render();
    expect(forks(container).map((f) => f.textContent?.includes('% of readers'))).toEqual([
      false,
      false,
    ]);
    expect(
      container.querySelector('[data-testid="storyline-shares-pending"]')?.textContent
    ).toContain('3 of 20 choices');
  });

  it('tags each fork with its chapter id and any tombstone, for the end-to-end spec', () => {
    mocks.children = [child(5, 'canon', 'Kept'), child(8, 'community', null)];
    const container = render();
    expect(forks(container).map((f) => [f.dataset.chapterId, f.dataset.tombstone])).toEqual([
      ['5', undefined],
      ['8', 'removed'],
    ]);
  });

  it('keeps the server order even where it differs from rank order', () => {
    mocks.children = [
      child(7, 'community', 'Most read'),
      child(5, 'canon', 'Canon'),
      child(6, 'endorsed', 'Endorsed'),
    ];
    const container = render();
    const cards = forks(container);
    expect(cards.map((c) => c.dataset.chapterId)).toEqual(['7', '5', '6']);
    expect(cards.map((c) => c.textContent?.endsWith('Read'))).toEqual([true, false, false]);
  });

  it('records the click on Create the next section and opens the early access prompt', () => {
    mocks.children = [];
    const container = render();
    expect(container.textContent).toContain('The story stops here, for now');
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Create the next section')
    );
    act(() => button?.click());
    expect(mocks.trackCreateClick).toHaveBeenCalledWith({ chapterId: 4 });
    expect(mocks.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ props: { chapterId: 4, storylineId: 9 } })
    );
  });
});
