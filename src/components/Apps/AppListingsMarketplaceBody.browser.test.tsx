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
        ? { kind: 'onsite', appBlockId: `blk-${id}`, hasPage: false }
        : { kind: 'offsite', subKind: 'external-link', externalUrl: 'https://x.app' },
  };
}

const mocks = vi.hoisted(() => ({
  items: [] as ListingCard[],
  lastArgs: null as null | Record<string, unknown>,
}));

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
});
