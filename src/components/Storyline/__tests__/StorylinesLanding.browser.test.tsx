import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as HomeContentToggleMod from '~/components/HomeContentToggle/HomeContentToggle';
import type * as IsMobileMod from '~/hooks/useIsMobile';
import type * as BrowsingLevelMod from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useRouter } from 'next/router';
import StorylinesPage from '~/pages/storylines';
import { SubNav2 } from '~/components/AppLayout/SubNav';
import { StorylineFeedFilters } from '~/components/Storyline/StorylineFeedFilters';
import { STORYLINES_INTRO_DISMISSED_KEY } from '~/components/Storyline/StorylinesIntro';

/**
 * The /storylines landing, clicked through in a real browser: the welcome can be dismissed and
 * brought back, and the sort and filter menus live in the sub-nav and reach the feed through the URL.
 */

const mocks = vi.hoisted(() => ({ feedInput: vi.fn() }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getInfinite': {
        useInfiniteQuery: (input: unknown) => {
          mocks.feedInput(input);
          return {
            data: { pages: [{ items: [], nextCursor: undefined }] },
            isError: false,
            refetch: vi.fn(),
            isLoading: false,
            hasNextPage: false,
            fetchNextPage: vi.fn(),
            isFetching: false,
          };
        },
      },
    }),
  };
});
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelMod>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobileMod>()),
  useIsMobile: () => false,
}));
// The page's server half is not under test, and does not load in a browser.
vi.mock('~/server/utils/server-side-helpers', () => ({ createServerSideProps: () => undefined }));
vi.mock('~/components/MasonryColumns/MasonryContainer', () => ({
  MasonryContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
// The sub-nav's other children; only its filter section is under test.
vi.mock('~/components/HomeContentToggle/HomeContentToggle', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeContentToggleMod>()),
  HomeTabs: () => null,
}));
vi.mock('~/components/Alerts/NavCustomizeNotice', () => ({ NavCustomizeNotice: () => null }));
vi.mock('~/components/HomeContentToggle/SubNavSettingsButton', () => ({
  SubNavSettingsButton: () => null,
}));

const welcome = () => page.getByRole('heading', { name: 'Welcome to Storylines' });

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.feedInput.mockReset();
  localStorage.removeItem(STORYLINES_INTRO_DISMISSED_KEY);
});

describe('the /storylines landing', () => {
  test('"Got it" hides the welcome for good, and "What are storylines?" brings it back', async () => {
    renderWithProviders(<StorylinesPage />);
    await expect.element(welcome()).toBeVisible();
    // While the welcome is showing there is nothing to bring back.
    expect(page.getByRole('button', { name: 'What are storylines?' }).elements()).toHaveLength(0);

    await page.getByRole('button', { name: 'Got it' }).click();
    await expect.element(welcome()).not.toBeInTheDocument();
    expect(localStorage.getItem(STORYLINES_INTRO_DISMISSED_KEY)).toBe('1');

    await page.getByRole('button', { name: 'What are storylines?' }).click();
    await expect.element(welcome()).toBeVisible();
    expect(localStorage.getItem(STORYLINES_INTRO_DISMISSED_KEY)).toBeNull();
    expect(page.getByRole('button', { name: 'What are storylines?' }).elements()).toHaveLength(0);
  });

  test('the hero shows the demo art from the edge, with a play button for the film', async () => {
    renderWithProviders(<StorylinesPage />);
    await expect.element(welcome()).toBeVisible();
    const hero = page.getByTestId('storylines-intro-hero').element();
    expect(hero.querySelector('img')?.getAttribute('src')).toContain(
      'c86ab790-e9ae-4f8b-9460-bfa77aca52ab'
    );
    expect(hero.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Watch the Storylines video'
    );
  });

  test('the page itself has no sort or filter menus, and no "Discover" heading', async () => {
    renderWithProviders(<StorylinesPage />);
    await expect.element(page.getByRole('heading', { name: 'Storylines', level: 1 })).toBeVisible();
    expect(document.body.textContent).not.toContain('Discover');
    expect(page.getByRole('button', { name: 'Newest' }).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Filters' }).elements()).toHaveLength(0);
  });

  test('the feed reads its sort and filter from the URL the sub-nav writes', async () => {
    const router = useRouter();
    router.query = { sort: 'mostChapters', filter: 'open' };
    try {
      renderWithProviders(<StorylinesPage />);
      await expect
        .poll(() => mocks.feedInput.mock.lastCall?.[0])
        .toEqual(expect.objectContaining({ sort: 'mostChapters', filter: 'open' }));
    } finally {
      router.query = {};
    }
  });

  test('picking a sort in the sub-nav writes it to the URL, shallowly', async () => {
    const router = useRouter();
    router.pathname = '/storylines';
    vi.mocked(router.replace).mockClear();
    try {
      renderWithProviders(<StorylineFeedFilters />);
      await page.getByRole('button', { name: 'Newest' }).click();
      await page.getByRole('menuitem', { name: 'Most chapters' }).click();
      expect(router.replace).toHaveBeenCalledWith(
        { pathname: '/storylines', query: { sort: 'mostChapters' } },
        undefined,
        { shallow: true, scroll: false }
      );
    } finally {
      router.pathname = '/';
    }
  });

  test('picking the default sort drops it from the URL, keeping the filter', async () => {
    const router = useRouter();
    router.pathname = '/storylines';
    router.query = { sort: 'mostChapters', filter: 'open' };
    vi.mocked(router.replace).mockClear();
    try {
      renderWithProviders(<StorylineFeedFilters />);
      await page.getByRole('button', { name: 'Most chapters' }).click();
      await page.getByRole('menuitem', { name: 'Newest' }).click();
      expect(router.replace).toHaveBeenCalledWith(
        { pathname: '/storylines', query: { filter: 'open' } },
        undefined,
        { shallow: true, scroll: false }
      );
    } finally {
      router.pathname = '/';
      router.query = {};
    }
  });

  test('the sub-nav carries the sort and filter menus on /storylines', async () => {
    const router = useRouter();
    router.pathname = '/storylines';
    try {
      renderWithProviders(<SubNav2 />);
      await expect.element(page.getByRole('button', { name: 'Newest' })).toBeVisible();
      await expect.element(page.getByRole('button', { name: 'Filters' })).toBeVisible();
    } finally {
      router.pathname = '/';
    }
  });
});
