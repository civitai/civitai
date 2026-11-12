import { afterEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

vi.mock('next/router', () => ({
  useRouter: () => ({
    isReady: true,
    query: { id: 'images-overall' },
    pathname: '/',
    replace: vi.fn(),
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));

// The row's content reaches session and cosmetics contexts; only the row box matters here.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: () => <div style={{ height: 40 }} />,
}));
vi.mock('~/components/Leaderboard/LeaderboardMetrics', () => ({
  LeaderboardMetrics: () => <div style={{ height: 40 }} />,
}));

import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { CreatorList } from '~/components/Leaderboard/CreatorList';
import type { LeaderboardGetModel } from '~/types/router';

/**
 * A sidebar rank badge navigates with router.replace('#46'), which is history.replaceState
 * and fires no `hashchange`. The rows used to read the hash only on mount or on `hashchange`,
 * and are keyed by position, so on a board whose rows were already mounted nothing scrolled:
 * the tester's URL said #46 while the viewport sat at ranks 11-14.
 */
const board = (userIdOffset: number) =>
  Array.from({ length: 80 }, (_, i) => ({
    position: i + 1,
    score: 1000 - i,
    date: new Date('2026-11-12T00:00:00Z'),
    delta: null,
    metrics: [],
    user: {
      id: userIdOffset + i,
      username: `user${userIdOffset + i}`,
      deletedAt: null,
      image: null,
      cosmetics: [],
      profilePicture: null,
    },
  })) as unknown as LeaderboardGetModel[];

// The rows render through useInView, which needs the provider the app mounts at the root.
const list = (props: React.ComponentProps<typeof CreatorList>) => (
  <IntersectionObserverProvider>
    <CreatorList {...props} />
  </IntersectionObserverProvider>
);

const inViewport = (position: number) => {
  const rect = document.getElementById(String(position))!.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= window.innerHeight;
};

afterEach(() => {
  window.history.replaceState(null, '', window.location.pathname);
  window.scrollTo(0, 0);
});

describe('CreatorList scrolls to the requested position', () => {
  test('scrolls when the position arrives on rows that are already mounted', async () => {
    const data = board(0);
    const screen = await renderWithProviders(list({ data, scrollRequest: 0 }));
    expect(inViewport(46)).toBe(false);

    // What the badge click does: replaceState, no hashchange, rows stay mounted. Only the
    // position changes; the page bumps scrollRequest for a repeat click alone.
    window.history.replaceState(null, '', '#46');
    await screen.rerender(list({ data, highlightedPosition: 46, scrollRequest: 0 }));

    await expect.poll(() => inViewport(46), { timeout: 2000 }).toBe(true);
  });

  test('scrolls again when the same badge is clicked after scrolling away', async () => {
    const data = board(0);
    window.history.replaceState(null, '', '#46');
    const screen = await renderWithProviders(
      list({ data, highlightedPosition: 46, scrollRequest: 1 })
    );
    await expect.poll(() => inViewport(46), { timeout: 2000 }).toBe(true);

    window.scrollTo(0, 0);
    await expect.poll(() => inViewport(46)).toBe(false);
    await screen.rerender(list({ data, highlightedPosition: 46, scrollRequest: 2 }));

    await expect.poll(() => inViewport(46), { timeout: 2000 }).toBe(true);
  });

  test('scrolls when another board loads at the same position', async () => {
    // #46 on one board, then the badge for #46 on another: the position doesn't change, only
    // the rows' data does, and the rows stay mounted.
    window.history.replaceState(null, '', '#46');
    const screen = await renderWithProviders(
      list({ data: board(0), highlightedPosition: 46, scrollRequest: 0 })
    );
    await expect.poll(() => inViewport(46), { timeout: 2000 }).toBe(true);

    window.scrollTo(0, 0);
    await expect.poll(() => inViewport(46)).toBe(false);
    await screen.rerender(list({ data: board(1000), highlightedPosition: 46, scrollRequest: 0 }));

    await expect.poll(() => inViewport(46), { timeout: 2000 }).toBe(true);
  });

  test('does not pull the viewport back on a rerender with nothing new', async () => {
    const data = board(0);
    window.history.replaceState(null, '', '#46');
    const screen = await renderWithProviders(
      list({ data, highlightedPosition: 46, scrollRequest: 0 })
    );
    await expect.poll(() => inViewport(46), { timeout: 2000 }).toBe(true);

    window.scrollTo(0, 0);
    await expect.poll(() => inViewport(46)).toBe(false);
    await screen.rerender(list({ data, highlightedPosition: 46, scrollRequest: 0 }));
    // Let any effect and the scroll it would start land before asserting it didn't happen.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    expect(inViewport(46)).toBe(false);
  });
});
