import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * P2b AppListingsMarketplaceBody wiring tests (REPORT-ONLY). Network-free — the
 * P2a `appListings.listAvailable` infinite query + feature flags are mocked.
 * Covers the kind filter passing through to the query args, the sort/category
 * controls rendering, and the card grid rendering the returned listings.
 */

function makeCard(id: string, name: string, kind: 'onsite' | 'offsite' = 'onsite'): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind,
    name,
    tagline: 'tag',
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    kindData:
      kind === 'onsite'
        ? { kind: 'onsite', appBlockId: `blk-${id}`, hasPage: false, liveUrl: `https://slug-${id}.civit.ai` }
        : { kind: 'offsite', subKind: 'external-link', externalUrl: 'https://x.app' },
  };
}

/**
 * The whitespace-stripped CSS Mantine generated for THIS element's own responsive
 * class. `Grid.Col` renders an `InlineStyles` <style> block keyed on a random
 * per-instance class, so scoping to that class keeps the assertions immune to
 * style blocks left behind by other tests in the same document.
 */
function generatedCssFor(el: HTMLElement): string {
  const classes = Array.from(el.classList);
  return Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .filter((text) => classes.some((c) => text.includes(`.${c}`)))
    .join('\n')
    .replace(/\s+/g, '');
}

const mocks = vi.hoisted(() => ({
  items: [] as ListingCard[],
  lastArgs: null as null | Record<string, unknown>,
}));

// The grid renders AppListingCard, which calls useCurrentUser() (owner "Edit"
// deep-link gate, added in #3392). Without a mock it hits the real
// CivitaiSessionContext — absent in the provider stack — and throws "missing
// CivitaiSessionContext", crashing every card render. Mock a signed-out viewer.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock): a hand-written replacement silently breaks every importer the
// day '~/utils/trpc' grows an export this factory omits — the whole FILE then
// fails to load with 0 tests collected and no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: {
        useInfiniteQuery: (input: Record<string, unknown>) => {
          mocks.lastArgs = input;
          return {
            data: { pages: [{ items: mocks.items, nextCursor: undefined }] },
            isLoading: false,
            isFetchingNextPage: false,
            fetchNextPage: vi.fn(),
            hasNextPage: false,
          };
        },
      },
    },
  },
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
}));

// The filters now live in the shared `AdaptiveFiltersDropdown`, which pulls in two
// providers the component harness does not mount and which THROW rather than
// returning a default:
//  - `useIsClient()` throws "missing IsClientContext" (it gates the count Indicator);
//  - `useIsMobile()` -> `useContainerQuery` -> `useContainerContext()` throws without a
//    ContainerProvider (it picks the desktop popover vs the mobile drawer).
// Unmocked, either takes the whole body down with an empty <body> and every assertion
// below fails by burning its timeout. `isClient: true` = post-hydration (so the count
// badge renders); `mobile: false` = the desktop popover path. The mobile drawer path
// and the pre-hydration path get their own files.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));

// Import AFTER mocks (vi.mock is hoisted, static imports are not).
const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');
const { clearRecentlyOpenedApps, recordRecentlyOpenedApp } = await import(
  './recentlyOpenedAppsStore'
);

/**
 * The scaffold's SHARED router singleton. A per-file `vi.mock('next/router')`
 * SILENTLY LOSES to the setup-file mock in `test/component-setup.tsx` (documented
 * the hard way in `AppEditPage.browser.test.tsx`, where `?tab=` could never be
 * seeded) — so seed `router.query` on the shared object instead.
 *
 * The store's filters now live in the URL, which splits every filter assertion in
 * two: seeding `router.query` covers the READ, and inspecting `router.replace`
 * covers the WRITE. The harness's `replace` is an inert `vi.fn()` — it does not
 * feed the new query back into `router.query` and could not re-render if it did —
 * so a single test that clicks a toggle and then reads the tRPC args would assert
 * the OLD value and pass for the wrong reason. Keep the two halves separate.
 */
// NOTE the disable is the LAST comment line before the statement — an
// `eslint-disable-next-line` followed by MORE comment lines disables the next
// COMMENT, not the code, and silently does nothing.
//
// Not a real hook: the scaffold mocks `next/router` with `useRouter: () => router`,
// a plain function returning a singleton, so module-scope is fine (and is the
// established idiom — a per-file `vi.mock` silently loses to the setup-file mock;
// see AppEditPage.browser.test.tsx).
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();

beforeEach(() => {
  mocks.items = [makeCard('a', 'Alpha App'), makeCard('b', 'Bravo App', 'offsite')];
  mocks.lastArgs = null;
  // A FRESH object each test: `useZodRouteParams` memoises on the `query`
  // reference, so mutating the previous object in place would be invisible.
  router.query = {};
  vi.mocked(router.replace).mockClear();
  clearRecentlyOpenedApps();
});

/** Open the collapsed Filters dropdown — kind/category live inside it now. */
async function openFilters() {
  await userEvent.click(page.getByRole('button', { name: 'Filters' }));
  await expect.element(page.getByTestId('apps-store-filters-panel')).toBeInTheDocument();
}

describe('AppListingsMarketplaceBody', () => {
  test('renders the returned listings as cards + the inline search/sort controls', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    await expect.element(page.getByText('Bravo App')).toBeInTheDocument();
    // Search + sort stay INLINE (not behind the Filters button), and both still
    // have an accessible name after their VISIBLE labels were dropped for the
    // single-row layout — the icon + placeholder are not an accessible name.
    // (Mantine's `Select` mirrors `aria-label` onto BOTH the input and its
    // listbox, hence `.first()`: the input is the control under test.)
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Sort').first()).toHaveValue('Top rated');
    // Kind filter is now inside the dropdown, defaulting to All.
    await openFilters();
    await expect
      .element(page.getByRole('button', { name: 'All apps' }))
      .toHaveAttribute('aria-pressed', 'true');
    // Query fired with kind=all default.
    expect(mocks.lastArgs).toMatchObject({ kind: 'all', sort: 'top-rated', limit: 24 });
  });

  test('clicking a kind toggle WRITES kind to the URL (shallow, no scroll)', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await openFilters();
    await userEvent.click(page.getByRole('button', { name: 'Off-site' }));

    expect(router.replace).toHaveBeenCalled();
    const [url, , options] = vi.mocked(router.replace).mock.calls.at(-1)!;
    expect(url).toMatchObject({ query: { kind: 'offsite' } });
    // Shallow so the filter change doesn't re-run getServerSideProps, and
    // scroll:false so it doesn't jump the viewport mid-browse.
    expect(options).toMatchObject({ shallow: true, scroll: false });
  });

  test('a param-seeded mount drives the tRPC query from the URL (the shareable-link path)', async () => {
    router.query = { kind: 'offsite', category: 'generation', sort: 'newest' };
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();
    expect(mocks.lastArgs).toMatchObject({
      kind: 'offsite',
      category: 'generation',
      sort: 'newest',
    });
  });

  /** Every `router.replace` call's resulting query object, oldest-first. */
  function replacedQueries(): Record<string, unknown>[] {
    return vi
      .mocked(router.replace)
      .mock.calls.map(([url]) => (url as { query?: Record<string, unknown> }).query ?? {});
  }

  test('🔴 the search box does NOT write the URL per keystroke — only the debounced value', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    const search = page.getByLabelText('Search');

    // Five successive input events inside the 300ms debounce window. Writing per
    // keystroke would push five history entries and make Back unusable (one
    // press per letter typed).
    for (const value of ['m', 'ma', 'mat', 'matr', 'matri', 'matrix']) {
      await search.fill(value);
    }
    // Nothing written yet — the debounce has not elapsed.
    expect(replacedQueries().filter((q) => 'query' in q)).toHaveLength(0);

    // …and after it does, exactly ONE write, carrying the FINAL value.
    await vi.waitFor(() => {
      const writes = replacedQueries().filter((q) => 'query' in q);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ query: 'matrix' });
    });
  });

  test('a `?query=` param seeds the search box and filters the grid', async () => {
    router.query = { query: 'Alpha' };
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Search')).toHaveValue('Alpha');
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    // Bravo is filtered out client-side by the seeded query.
    expect(page.getByText('Bravo App').elements()).toHaveLength(0);
  });

  test('sorting writes the sort param', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await userEvent.click(page.getByLabelText('Sort').first());
    await userEvent.click(page.getByRole('option', { name: 'Newest' }));
    expect(replacedQueries().at(-1)).toMatchObject({ sort: 'newest' });
  });

  test('a DEFAULT value is stripped from the URL rather than written as noise', async () => {
    router.query = { kind: 'offsite' };
    renderWithProviders(<AppListingsMarketplaceBody />);
    await openFilters();
    await userEvent.click(page.getByRole('button', { name: 'All apps' }));
    // `?kind=all` is the default view — a nav that lands on
    // `/apps?kind=all&sort=top-rated` looks like state you have to clear.
    expect(replacedQueries().at(-1)).not.toHaveProperty('kind');
  });

  test('empty result → "No apps yet"', async () => {
    mocks.items = [];
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('No apps yet')).toBeInTheDocument();
  });

  // ── Larger covers (feedback #1): the grid geometry ──────────────────────────
  // The numbers themselves are pinned in the blocking unit suite
  // (__tests__/appListingGrid.test.ts). What this asserts is the WIRING: the grid
  // actually renders with that shared span object, so the two can't drift.
  test('the grid renders each card with the shared LISTING_GRID_SPAN (xl = 4 columns)', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();

    const cols = page.getByTestId('apps-listing-grid-col').elements();
    expect(cols).toHaveLength(mocks.items.length);

    // Mantine Grid.Col compiles the responsive span into a generated <style>
    // block of `--col-flex-basis` percentages (one media rule per breakpoint).
    // The OLD `xl: 2.4` (five columns) compiled to a 20% basis; the NEW `xl: 3`
    // compiles to 25%. So the absence of a 20% basis is a direct, mutation-
    // sensitive assertion that the five-column xl layout is gone — flip the span
    // back to 2.4 and this fails. The exact per-breakpoint numbers are pinned in
    // the blocking unit suite (__tests__/appListingGrid.test.ts).
    //
    // Scoped to the styles Mantine generated for THIS column's own random class,
    // not every <style> in the document — a document-wide scan would make the
    // negative assertion below sensitive to style leakage from other tests.
    const css = generatedCssFor(cols[0] as HTMLElement);

    // Every basis Mantine emitted for this column — the base rule first, then one
    // per breakpoint in ascending order: base 12 → 100% (1 col), sm 6 → 50% (2),
    // md 4 → 33.3% (3), lg 3 → 25% (4), xl 3 → 25% (4). The OLD `xl: 2.4` compiled
    // to a 20% basis, so this pins the whole responsive sequence AND proves the
    // retired 5-column xl is gone. Flipping the span back to 2.4 fails here.
    const bases = Array.from(css.matchAll(/--col-flex-basis:([\d.]+)%/g)).map((m) => m[1]);
    expect(bases).toEqual(['100', '50', '33.333333333333336', '25', '25']);
    expect(css).not.toContain('--col-flex-basis:20%'); // 2.4/12 — the retired 5-col xl
  });

  // ── "Recently opened" rail ──────────────────────────────────────────────────
  // Selection/target logic is pinned in the CI-run node unit suite
  // (__tests__/recentAppsRail.test.ts). What these assert is the WIRING: the
  // page really reads the store after mount, really renders the rail BELOW the
  // search/filter controls but ABOVE the result grid, and really renders NOTHING
  // for a viewer with no recents.

  test('a viewer with NO recents sees no rail at all (no heading, no reserved space)', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    expect(page.getByTestId('apps-recent-rail').elements()).toHaveLength(0);
    expect(page.getByText('Recently opened').elements()).toHaveLength(0);
  });

  test('🔴 a viewer WITH recents sees the rail BELOW the controls and ABOVE the grid (CLS)', async () => {
    recordRecentlyOpenedApp({
      id: 'ab_1',
      blockId: 'gen-matrix',
      slug: 'gen-matrix',
      kind: 'onsite',
      hasPage: true,
      name: 'Gen Matrix',
    });
    renderWithProviders(<AppListingsMarketplaceBody />);

    const rail = page.getByTestId('apps-recent-rail');
    await expect.element(rail).toBeInTheDocument();
    await expect.element(page.getByText('Gen Matrix')).toBeInTheDocument();

    // Document order, asserted on BOTH sides — `compareDocumentPosition` is the
    // direct encoding of position, where a visual-only check would pass with the
    // rail appended at the bottom like the legacy body did.
    const railEl = rail.element();
    const search = page.getByLabelText('Search').element();
    const firstCard = page.getByTestId('apps-listing-grid-col').elements()[0];

    // 1. The rail comes AFTER the search input. The rail hydrates one frame late
    //    (localStorage is client-only), so placing it above the primary controls
    //    shifted them down by ~90px after paint — a CLS regression Faro RUM
    //    reports for this page. Below the controls, the late insertion only moves
    //    the grid.
    expect(search.compareDocumentPosition(railEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 2. …but still BEFORE the first result card, so "jump back in" outranks
    //    browsing and stays above the fold.
    expect(
      railEl.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('a LEGACY {id, blockId} recents entry still renders (resolved, not dropped)', async () => {
    recordRecentlyOpenedApp({ id: 'ab_legacy', blockId: 'legacy-app' });
    renderWithProviders(<AppListingsMarketplaceBody />);
    const item = page.getByTestId('apps-recent-rail-item');
    await expect.element(item).toBeInTheDocument();
    // hasPage unknown for a legacy entry → the always-valid detail link.
    await expect.element(item).toHaveAttribute('href', '/apps/store-preview/legacy-app');
  });
});
