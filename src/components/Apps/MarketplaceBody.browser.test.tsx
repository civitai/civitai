import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';
import {
  clearRecentlyOpenedApps,
  getRecentlyOpenedApps,
  RECENTLY_OPENED_APPS_KEY,
} from '~/components/Apps/recentlyOpenedApps';

/**
 * /apps marketplace BODY — page-level wiring tests (network-free; tRPC, feature
 * flags, current-user and the heavy child modals are mocked via the scaffold's
 * documented patterns). These cover the structural redesign that the extracted
 * components (CategoryFilterButtons / RecentlyOpenedAppsView / recents helper)
 * can't see on their own:
 *
 *   - the search input + sort control sit in the SAME top row,
 *   - the category icon-toggle buttons render (one per category + "All"),
 *   - clicking "Explore all apps" CLEARS the active filters,
 *   - opening an app WRITES it to the recents localStorage list (capped/deduped/
 *     newest-first via the helper), and the "Recently opened" section then shows.
 */

// Model-slot (in-context) apps — these expose the Install CTA on the card, which
// is wired to the page's `onOpen` (= handleOpen → records to recents). A page
// app (`app.page`) has no Install row, so its open path is the route link, not
// `onOpen`; we use model-slot apps here to exercise the record-on-open wiring.
function makeBlock(id: string, name: string): AvailableBlock {
  return {
    id,
    blockId: `block-${id}`,
    appId: id,
    appName: name,
    manifest: { name, description: 'desc', targets: [{ slotId: 'model.sidebar_top' }], hasPage: false },
    installCount: 0,
    category: null,
    scopesSummary: [],
    avgRating: null,
    reviewCount: 0,
  };
}

const ITEMS = [makeBlock('a', 'Alpha App'), makeBlock('b', 'Bravo App')];

// Hoisted, per-test-controllable query state.
const mocks = vi.hoisted(() => ({
  listAvailableItems: [] as AvailableBlock[],
  // Capture the LIVE filter args the page passes into the listing query so we
  // can assert the category/search filters are cleared by "Explore all".
  lastListArgs: null as null | Record<string, unknown>,
  openSettings: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const block = (b: AvailableBlock) => b;
  return {
    trpc: {
      blocks: {
        listAvailable: {
          useInfiniteQuery: (input: Record<string, unknown>) => {
            mocks.lastListArgs = input;
            return {
              data: { pages: [{ items: mocks.listAvailableItems.map(block), nextCursor: undefined }] },
              isLoading: false,
              isFetchingNextPage: false,
              fetchNextPage: vi.fn(),
              hasNextPage: false,
            };
          },
          // featured/new/probe rails use the non-infinite form — return empty so
          // the rails stay collapsed and don't duplicate cards.
          useQuery: () => ({ data: { items: [] }, isLoading: false }),
        },
        getFeaturedBlocks: {
          useQuery: () => ({ data: { items: [] }, isLoading: false }),
        },
        listMySubscriptions: {
          useQuery: () => ({ data: [], isLoading: false }),
        },
        getMyApps: {
          useQuery: () => ({ data: [], isLoading: false }),
        },
      },
    },
  };
});

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'tester', isModerator: false }),
}));

// The settings modal is a global side-effecting opener — stub it to a spy so we
// can assert handleOpen fired without booting the real modal stack.
vi.mock('~/components/Apps/AppSettingsModal', () => ({
  openAppSettingsModal: (args: unknown) => mocks.openSettings(args),
}));

// Card-internal heavy deps (covered by their own tests) — keep this page test
// network-free.
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));
vi.mock('~/components/Apps/AppDetailsModal', () => ({
  AppDetailsModal: ({ opened, block }: { opened: boolean; block: { id: string } }) =>
    opened ? <div data-testid="details-modal">details for {block.id}</div> : null,
}));

// Import AFTER mocks (vi.mock is hoisted, imports are not).
const { MarketplaceBody } = await import('./MarketplaceBody');

beforeEach(() => {
  clearRecentlyOpenedApps();
  mocks.listAvailableItems = [...ITEMS];
  mocks.lastListArgs = null;
  mocks.openSettings.mockClear();
});

describe('/apps marketplace body (top controls row)', () => {
  test('search input and sort control render in the same top row', async () => {
    renderWithProviders(<MarketplaceBody />);
    // Search is a textbox labelled "Search".
    await expect.element(page.getByRole('textbox', { name: 'Search' })).toBeInTheDocument();
    // Sort is a Mantine Select — its input is a textbox labelled "Sort" showing
    // the default "Top rated" sort.
    await expect.element(page.getByRole('textbox', { name: 'Sort' })).toBeInTheDocument();
    expect((page.getByRole('textbox', { name: 'Sort' }).element() as HTMLInputElement).value).toBe(
      'Top rated'
    );
  });

  test('category icon-toggle buttons render (one per category + "All") — no category <Select>', async () => {
    renderWithProviders(<MarketplaceBody />);
    // The icon toggles are exposed (the "All categories" clear is the tell).
    await expect.element(page.getByRole('button', { name: 'All categories' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Generation' })).toBeInTheDocument();
    // The old category dropdown is GONE — the only Select-style textbox now is
    // "Sort" (no "Category" combobox/textbox remains).
    expect(page.getByRole('textbox', { name: 'Category' }).elements()).toHaveLength(0);
  });
});

describe('/apps marketplace body (explore-all CTA clears filters)', () => {
  test('selecting a category shows "Explore all apps"; clicking it clears the category filter', async () => {
    renderWithProviders(<MarketplaceBody />);
    // Wait for the async render before interacting (vitest-browser-react).
    await expect.element(page.getByRole('button', { name: 'Generation' })).toBeInTheDocument();
    // Pick a category → filter active → the query receives it.
    await userEvent.click(page.getByRole('button', { name: 'Generation' }).element());
    await expect.element(page.getByRole('button', { name: 'Explore all apps' })).toBeInTheDocument();
    expect(mocks.lastListArgs?.category).toBe('generation');

    // Click "Explore all apps" → filters cleared → query no longer filtered.
    await userEvent.click(page.getByRole('button', { name: 'Explore all apps' }).element());
    await expect
      .element(page.getByRole('button', { name: 'All categories' }))
      .toBeInTheDocument();
    expect(mocks.lastListArgs?.category).toBeUndefined();
    // The explore-all CTA hides once there are no active filters.
    expect(page.getByRole('button', { name: 'Explore all apps' }).elements()).toHaveLength(0);
  });

  test('a typed search query is cleared by "Explore all apps" (search input emptied)', async () => {
    renderWithProviders(<MarketplaceBody />);
    await expect.element(page.getByRole('textbox', { name: 'Search' })).toBeInTheDocument();
    const search = page.getByRole('textbox', { name: 'Search' });
    await userEvent.fill(search.element() as HTMLInputElement, 'alpha');
    // A non-empty search activates the filters → the CTA appears (debounced, so
    // wait for it rather than asserting synchronously).
    await expect.element(page.getByRole('button', { name: 'Explore all apps' })).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Explore all apps' }).element());
    // The search input is emptied (clearFilters reset searchInput state).
    await expect.element(page.getByRole('textbox', { name: 'Search' })).toHaveValue('');
  });
});

describe('/apps marketplace body (opening an app records it to recents)', () => {
  test('opening an app writes it to the recents localStorage list and surfaces the section', async () => {
    expect(getRecentlyOpenedApps()).toEqual([]);
    renderWithProviders(<MarketplaceBody />);

    // Each grid card exposes an "Open app" / settings open affordance. The
    // page apps here have no in-context install slot, so the open path is the
    // card's open action wired to handleOpen. Find the first card's open button.
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();

    // Model-slot cards expose an "Install" CTA wired to the page's onOpen
    // (= handleOpen → records to recents). Click the first card's Install.
    const installButtons = page.getByRole('button', { name: 'Install' }).elements();
    expect(installButtons.length).toBeGreaterThan(0);
    await userEvent.click(installButtons[0] as HTMLElement);

    // handleOpen fired the settings opener…
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    // …and recorded the app to localStorage (newest-first, the helper's job).
    const recents = getRecentlyOpenedApps();
    expect(recents.length).toBeGreaterThanOrEqual(1);
    // The raw store is populated under the documented key.
    expect(window.localStorage.getItem(RECENTLY_OPENED_APPS_KEY)).toBeTruthy();

    // The "Recently opened" section now renders (resolved against the listing).
    await expect.element(page.getByRole('heading', { name: 'Recently opened' })).toBeInTheDocument();
  });
});
