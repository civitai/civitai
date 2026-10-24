import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type {
  ListingCard,
  StoreGridItem,
  SubListingCard,
} from '~/server/schema/blocks/app-listing-read.schema';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/** The store grid renders a sub-listing item with its own card, beside the app cards. */

const mocks = vi.hoisted(() => ({
  items: [] as unknown[],
  canOpenPages: true,
  input: null as null | Record<string, unknown>,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appListings.listAvailable': {
      useInfiniteQuery: (input: Record<string, unknown>) => {
        mocks.input = input;
        return {
          data: { pages: [{ items: mocks.items, nextCursor: undefined }] },
          isLoading: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          hasNextPage: false,
        };
      },
    },
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: mocks.canOpenPages }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: mocks.canOpenPages }),
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsMobile: () => false,
  isMobileDevice: () => false,
}));

const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');

const PARENT: ListingCard = {
  id: 'apl_P',
  slug: 'custom-generators',
  kind: 'onsite',
  name: 'Custom Generators',
  tagline: 'Build your own',
  category: 'generation',
  contentRating: 'pg',
  isBeta: false,
  iconUrl: null,
  coverUrl: null,
  creator: null,
  recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
  reviewCount: 0,
  openCount: 0,
  restrictedAudience: null,
  kindData: { kind: 'onsite', appBlockId: 'ab_P', hasPage: true, liveUrl: 'https://x.civit.ai' },
};

const CHILD: SubListingCard = {
  cardType: 'sub-listing',
  id: 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A',
  name: 'Neon Portraits',
  tagline: 'Glowing headshots',
  kind: 'onsite',
  category: 'generation',
  contentRating: 'pg',
  coverUrl: null,
  creator: { id: 7, username: 'pixelwitch', image: null },
  parent: { id: 'apl_P', slug: 'custom-generators', name: 'Custom Generators', iconUrl: null },
  runHref: '/apps/run/custom-generators/g/NEON?sl=asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A',
};

beforeEach(() => {
  mocks.items = [PARENT, CHILD] satisfies StoreGridItem[];
  mocks.canOpenPages = true;
  mocks.input = null;
});

describe('store grid with sub-listings', () => {
  test('the store grid is the caller that opts in to sub-listing cards', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByTestId('apps-sub-listing-card')).toBeVisible();
    expect(mocks.input).toMatchObject({ includeSubListings: true });
  });

  test('renders the app card and the sub-listing card, in server order', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByTestId('apps-sub-listing-card')).toBeVisible();
    const cols = page.getByTestId('apps-listing-grid-col').elements();
    expect(cols).toHaveLength(2);
    expect(cols[0].querySelector('[data-testid="apps-sub-listing-card"]')).toBeNull();
    expect(cols[1].querySelector('[data-testid="apps-sub-listing-card"]')).not.toBeNull();
    expect(
      cols[1]
        .querySelector('[data-testid="apps-sub-listing-cta"]')
        ?.closest('a')
        ?.getAttribute('href')
    ).toBe(CHILD.runHref);
  });

  test('client-side search matches a sub-listing by its own title', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    const search = page.getByLabelText('Search');
    await search.fill('neon');
    await expect.poll(() => page.getByTestId('apps-listing-grid-col').elements().length).toBe(1);
    await expect.element(page.getByTestId('apps-sub-listing-card')).toBeVisible();
  });

  test('a page of only app cards renders no sub-listing card (positive control above)', async () => {
    mocks.items = [PARENT];
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Custom Generators').first()).toBeVisible();
    expect(page.getByTestId('apps-sub-listing-card').elements()).toHaveLength(0);
  });

  test('without app pages the sub-card sends the viewer to the parent store page', async () => {
    mocks.canOpenPages = false;
    renderWithProviders(<AppListingsMarketplaceBody />);
    const cta = page.getByTestId('apps-sub-listing-cta');
    await expect.element(cta).toBeVisible();
    expect(cta.element().closest('a')?.getAttribute('href')).toBe(
      '/apps/store-preview/custom-generators'
    );
  });
});
