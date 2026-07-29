import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { LISTING_GRID_SPAN } from '~/components/Apps/appListingGrid';
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

beforeEach(() => {
  mocks.items = [makeCard('a', 'Alpha App'), makeCard('b', 'Bravo App', 'offsite')];
  mocks.lastArgs = null;
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
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '');
    expect(css).toContain('--col-flex-basis:25%'); // 3/12 — the lg + xl columns
    expect(css).not.toContain('--col-flex-basis:20%'); // 2.4/12 — the retired 5-col xl

    // …and the grid is wired to the SHARED constant, so the unit pins above
    // actually govern what renders.
    expect(LISTING_GRID_SPAN.xl).toBe(3);
    expect(12 / LISTING_GRID_SPAN.xl).toBe(4);
    expect(LISTING_GRID_SPAN).toMatchObject({ base: 12, sm: 6, md: 4, lg: 3 });
  });
});
