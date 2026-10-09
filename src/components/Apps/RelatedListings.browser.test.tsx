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
  inputs: [] as Record<string, unknown>[],
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appListings.listAvailable': {
      useQuery: (input: Record<string, unknown>, opts?: { enabled?: boolean }) => {
        mocks.inputs.push(input);
        return {
          data: opts?.enabled === false ? undefined : { items: mocks.items },
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

function app(id: string, name: string): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
    name,
    tagline: null,
    category: 'generation',
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
