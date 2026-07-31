import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
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

vi.mock('~/utils/trpc', () => ({
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

// Import AFTER mocks (vi.mock is hoisted, static imports are not).
const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');
const { clearRecentlyOpenedApps, recordRecentlyOpenedApp } = await import(
  './recentlyOpenedAppsStore'
);

beforeEach(() => {
  mocks.items = [makeCard('a', 'Alpha App'), makeCard('b', 'Bravo App', 'offsite')];
  mocks.lastArgs = null;
  clearRecentlyOpenedApps();
});

describe('AppListingsMarketplaceBody', () => {
  test('renders the returned listings as cards + the kind/sort controls', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    await expect.element(page.getByText('Bravo App')).toBeInTheDocument();
    // Kind filter present, defaulting to All.
    await expect.element(page.getByRole('button', { name: 'All apps' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // Query fired with kind=all default.
    expect(mocks.lastArgs).toMatchObject({ kind: 'all', sort: 'top-rated', limit: 24 });
  });

  test('clicking a kind toggle passes kind through to the query', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await userEvent.click(page.getByRole('button', { name: 'Off-site' }));
    expect(mocks.lastArgs).toMatchObject({ kind: 'offsite' });
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
  // Selection/target logic is pinned in the blocking unit suite
  // (__tests__/recentAppsRail.test.ts). What these assert is the WIRING: the
  // page really reads the store after mount, really renders the rail ABOVE the
  // search box, and really renders NOTHING for a viewer with no recents.

  test('a viewer with NO recents sees no rail at all (no heading, no reserved space)', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    expect(page.getByTestId('apps-recent-rail').elements()).toHaveLength(0);
    expect(page.getByText('Recently opened').elements()).toHaveLength(0);
  });

  test('a viewer WITH recents sees the rail, above the search input', async () => {
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

    // Document order: the rail precedes the search field. `compareDocumentPosition`
    // is the direct encoding of "at the top" — a visual-only check would pass
    // even if the rail were appended at the bottom like the legacy body did.
    const railEl = rail.element();
    const search = page.getByLabelText('Search').element();
    expect(railEl.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
