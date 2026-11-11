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

/**
 * The related rail renders `ListingCard`s only: it must not ask for sub-listings, and must drop
 * any that arrive (`AppListingCard` reads `card.kindData.kind` and throws on one).
 */

const mocks = vi.hoisted(() => ({
  items: [] as unknown[],
  /** When set, the answer to the query WITHOUT a category (the popular top-up). */
  popularItems: null as unknown[] | null,
  inputs: [] as Record<string, unknown>[],
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appListings.listAvailable': {
      useQuery: (input: Record<string, unknown>, opts?: { enabled?: boolean }) => {
        mocks.inputs.push(input);
        const items =
          mocks.popularItems && input.category === undefined ? mocks.popularItems : mocks.items;
        return {
          data: opts?.enabled === false ? undefined : { items },
          isPending: opts?.enabled === false,
        };
      },
    },
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
}));

const { RelatedListings } = await import('./RelatedListings');

function app(id: string, name: string, category = 'generation'): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
    name,
    tagline: null,
    category,
    contentRating: null,
    isBeta: false,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    openCount: 0,
    restrictedAudience: null,
    kindData: {
      kind: 'onsite',
      appBlockId: `ab_${id}`,
      hasPage: true,
      liveUrl: 'https://x.civit.ai',
    },
  };
}

const CHILD: SubListingCard = {
  cardType: 'sub-listing',
  id: 'asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A',
  name: 'Neon Portraits',
  tagline: null,
  kind: 'onsite',
  category: 'generation',
  contentRating: null,
  coverUrl: null,
  creator: { id: 7, username: 'pixelwitch', image: null },
  parent: { id: 'apl_P', slug: 'custom-generators', name: 'Custom Generators', iconUrl: null },
  runHref: '/apps/run/custom-generators/g/NEON?sl=asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A',
};

beforeEach(() => {
  mocks.items = [];
  mocks.popularItems = null;
  mocks.inputs = [];
});

describe('RelatedListings with sub-listing cards in the response', () => {
  test('renders the app cards and skips a sub-listing card instead of crashing', async () => {
    mocks.items = [app('a1', 'Alpha App'), CHILD, app('a2', 'Beta App')] satisfies StoreGridItem[];
    renderWithProviders(<RelatedListings listingId="self" category="generation" />);
    await expect.element(page.getByText('Alpha App')).toBeVisible();
    await expect.element(page.getByText('Beta App')).toBeVisible();
    expect(page.getByTestId('apps-related-grid-col').elements()).toHaveLength(2);
    expect(page.getByText('Neon Portraits').elements()).toHaveLength(0);
  });

  test('never asks the server for sub-listings', async () => {
    mocks.items = [app('a1', 'Alpha App')];
    renderWithProviders(<RelatedListings listingId="self" category="generation" />);
    await expect.element(page.getByText('Alpha App')).toBeVisible();
    // Positive control: the rail did query, so an empty list below cannot pass vacuously.
    expect(mocks.inputs.length).toBeGreaterThan(0);
    expect(mocks.inputs.filter((i) => i.includeSubListings)).toEqual([]);
  });
});

describe('🔴 RelatedListings — the top-up renders under its own heading', () => {
  test('🔴 a thin category shows its apps under "More in", the any-category top-up under "Popular apps"', async () => {
    mocks.items = [app('g1', 'Gen One'), app('g2', 'Gen Two')];
    mocks.popularItems = [app('t1', 'Tool One', 'utility'), app('t2', 'Tool Two', 'utility')];
    renderWithProviders(<RelatedListings listingId="self" category="generation" />);

    const categoryGroup = page.getByRole('region', { name: 'More in Generation', exact: true });
    const popularGroup = page.getByRole('region', { name: 'Popular apps', exact: true });
    await expect.element(popularGroup).toBeVisible();
    await expect.element(categoryGroup.getByText('Gen One')).toBeVisible();
    await expect.element(popularGroup.getByText('Tool One')).toBeVisible();
    // The defect: a top-up app under the heading that names a different category.
    expect(categoryGroup.getByText('Tool One').elements()).toHaveLength(0);
    expect(categoryGroup.getByText('Tool Two').elements()).toHaveLength(0);
    expect(popularGroup.getByText('Gen One').elements()).toHaveLength(0);
    // Positive control: all four cards rendered, so the absences above are not an empty rail.
    expect(page.getByTestId('apps-related-grid-col').elements()).toHaveLength(4);
  });

  test('a category with no other apps shows no "More in" heading at all', async () => {
    mocks.items = [];
    mocks.popularItems = [app('t1', 'Tool One', 'utility')];
    renderWithProviders(<RelatedListings listingId="self" category="generation" />);
    await expect
      .element(page.getByRole('region', { name: 'Popular apps', exact: true }))
      .toBeVisible();
    expect(page.getByText('More in Generation').elements()).toHaveLength(0);
  });
});
