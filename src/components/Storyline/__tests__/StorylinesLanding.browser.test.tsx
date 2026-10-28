import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as IsMobileMod from '~/hooks/useIsMobile';
import type * as BrowsingLevelMod from '~/components/BrowsingLevel/BrowsingLevelProvider';
import StorylinesPage from '~/pages/storylines';
import { STORYLINES_INTRO_DISMISSED_KEY } from '~/components/Storyline/StorylinesIntro';

/**
 * The /storylines landing, clicked through in a real browser: the welcome can be dismissed and
 * brought back, and the sort and filter menus sit up with the page title.
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

  test('the hero shows the demo art from the edge, with no play button until there is a film', async () => {
    renderWithProviders(<StorylinesPage />);
    await expect.element(welcome()).toBeVisible();
    const hero = page.getByTestId('storylines-intro-hero').element();
    expect(hero.querySelector('img')?.getAttribute('src')).toContain(
      'c86ab790-e9ae-4f8b-9460-bfa77aca52ab'
    );
    expect(hero.querySelector('button')).toBeNull();
  });

  test('the sort and filters sit beside the title, with no "Discover" heading', async () => {
    renderWithProviders(<StorylinesPage />);
    await expect.element(page.getByRole('heading', { name: 'Storylines', level: 1 })).toBeVisible();

    expect(document.body.textContent).not.toContain('Discover');
    const title = page.getByRole('heading', { name: 'Storylines', level: 1 }).element();
    const controls = page.getByRole('button', { name: 'Newest' }).element();
    // One row of controls with the title, above the welcome and the feed.
    const welcomeCard = page.getByRole('region', { name: 'Welcome to Storylines' }).element();
    expect(title.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      controls.compareDocumentPosition(welcomeCard) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await page.getByRole('button', { name: 'Newest' }).click();
    await page.getByRole('menuitem', { name: 'Most chapters' }).click();
    await expect
      .poll(() => mocks.feedInput.mock.lastCall?.[0])
      .toEqual(expect.objectContaining({ sort: 'mostChapters' }));
  });
});
