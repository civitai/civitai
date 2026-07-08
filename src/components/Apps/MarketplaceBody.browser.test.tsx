import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';
import {
  clearRecentlyOpenedApps,
  getRecentlyOpenedApps,
  RECENTLY_OPENED_APPS_KEY,
} from '~/components/Apps/recentlyOpenedAppsStore';

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
    externalUrl: null,
    scopesSummary: [],
    avgRating: null,
    reviewCount: 0,
    coverUrl: null,
  };
}

const ITEMS = [makeBlock('a', 'Alpha App'), makeBlock('b', 'Bravo App')];

// A PAGE app — no install slot (so no Install CTA); its open path is the route
// "Open app" link + the title/description detail links. Used for the M1
// route/title-records-to-recents coverage.
function makePageBlock(id: string, name: string): AvailableBlock {
  return {
    id,
    blockId: `block-${id}`,
    appId: id,
    appName: name,
    manifest: { name, description: 'desc', targets: [{ slotId: 'app.page' }], hasPage: true },
    installCount: 0,
    category: null,
    externalUrl: null,
    scopesSummary: [],
    avgRating: null,
    reviewCount: 0,
    coverUrl: null,
  };
}

// Hoisted, per-test-controllable query state.
const mocks = vi.hoisted(() => ({
  listAvailableItems: [] as AvailableBlock[],
  // Capture the LIVE filter args the page passes into the listing query so we
  // can assert the category/search filters are cleared by "Explore all".
  lastListArgs: null as null | Record<string, unknown>,
  openSettings: vi.fn(),
  // Per-test-controllable `appBlocksPages` flag (gates the "Open app" route
  // link). Default off (mirrors prod dark state); flip on for the route-link
  // M1 test.
  appBlocksPages: false,
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
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: mocks.appBlocksPages }),
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
  mocks.appBlocksPages = false;
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

describe('/apps marketplace body — PAGE app open records to recents (M1)', () => {
  // A page app has NO install slot → no Install CTA → it never fires the
  // install `onOpen`. Its open paths are the route "Open app" link (flag-gated)
  // and the detail-page title/description links. M1 wires `onRecentOpen` onto
  // those so a page app's main open populates "Recently opened".
  //
  // These are real Next `<Link>` anchors — a click would navigate the test
  // iframe and crash the runner. Install a capture-phase guard that
  // `preventDefault()`s the navigation; the card's bubble-phase `onClick`
  // (which records to recents) still fires before the browser navigates.
  const stopNav = (e: Event) => {
    if ((e.target as HTMLElement)?.closest('a')) e.preventDefault();
  };
  beforeEach(() => document.addEventListener('click', stopNav, true));
  afterEach(() => document.removeEventListener('click', stopNav, true));

  test('clicking "Open app" (route link) on a PAGE app records it to recents', async () => {
    mocks.appBlocksPages = true; // unlock the "Open app" route link
    mocks.listAvailableItems = [makePageBlock('p', 'Page App')];
    expect(getRecentlyOpenedApps()).toEqual([]);

    renderWithProviders(<MarketplaceBody />);
    await expect.element(page.getByText('Page App')).toBeInTheDocument();

    // The route link is the page app's primary open path.
    const openApp = page.getByRole('link', { name: /open app/i });
    await expect.element(openApp).toBeInTheDocument();
    await userEvent.click(openApp.element());

    // The install/settings opener did NOT fire (page app has no install) —
    // recents was populated purely by the route open.
    expect(mocks.openSettings).not.toHaveBeenCalled();
    const recents = getRecentlyOpenedApps();
    expect(recents.map((r) => r.id)).toContain('p');
    expect(window.localStorage.getItem(RECENTLY_OPENED_APPS_KEY)).toBeTruthy();
    // The "Recently opened" section renders for the page app.
    await expect.element(page.getByRole('heading', { name: 'Recently opened' })).toBeInTheDocument();
  });

  test('clicking the title link on a PAGE app also records it to recents (flag off)', async () => {
    // Title link is present regardless of the pages flag — assert it records too.
    mocks.appBlocksPages = false;
    mocks.listAvailableItems = [makePageBlock('p', 'Page App')];
    expect(getRecentlyOpenedApps()).toEqual([]);

    renderWithProviders(<MarketplaceBody />);
    // The card title links to the detail page; it is the open path here.
    const titleLink = page.getByRole('link', { name: /Page App/i }).first();
    await expect.element(titleLink).toBeInTheDocument();
    await userEvent.click(titleLink.element());

    expect(mocks.openSettings).not.toHaveBeenCalled();
    expect(getRecentlyOpenedApps().map((r) => r.id)).toContain('p');
    await expect.element(page.getByRole('heading', { name: 'Recently opened' })).toBeInTheDocument();
  });
});

describe('/apps marketplace body — sort default + fallback (M3)', () => {
  test('the listing query uses the visible default sort "rating" on first render', async () => {
    renderWithProviders(<MarketplaceBody />);
    // The Sort select shows the default "Top rated" (= rating) on first render,
    // and the listing query is invoked with sort:'rating'.
    await expect.element(page.getByRole('textbox', { name: 'Sort' })).toBeInTheDocument();
    expect(
      (page.getByRole('textbox', { name: 'Sort' }).element() as HTMLInputElement).value
    ).toBe('Top rated');
    expect(mocks.lastListArgs?.sort).toBe('rating');
  });
});

describe('/apps marketplace body — Explore-all CTA reacts to typing immediately (L1)', () => {
  test('the CTA appears as soon as the search input is non-empty (no 300ms debounce wait)', async () => {
    renderWithProviders(<MarketplaceBody />);
    const search = page.getByRole('textbox', { name: 'Search' });
    await expect.element(search).toBeInTheDocument();
    // Initially no active filters → no CTA.
    expect(page.getByRole('button', { name: 'Explore all apps' }).elements()).toHaveLength(0);

    // Type a single character — the CTA must appear (hasActiveFilters is now
    // keyed on the IMMEDIATE input, not the 300ms-debounced value). Pre-fix the
    // CTA only appeared after the debounce fired; reverting the L1 change (back
    // to keying hasActiveFilters on debouncedSearch) breaks the immediacy this
    // asserts. We synchronously check the CTA right after the input event,
    // before the debounce window could plausibly have elapsed.
    await userEvent.type(search.element() as HTMLInputElement, 'a');
    // Synchronous check (no retry/debounce wait): the button is in the DOM now.
    expect(page.getByRole('button', { name: 'Explore all apps' }).elements()).toHaveLength(1);
  });
});
