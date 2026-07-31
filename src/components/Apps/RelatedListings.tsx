import { Anchor, Center, Grid, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconLayoutGrid } from '@tabler/icons-react';
import Link from 'next/link';
import { AppListingCard } from '~/components/Apps/AppListingCard';
import {
  needsPopularTopUp,
  RELATED_LISTINGS_LIMIT,
  selectRelatedListings,
} from '~/components/Apps/relatedListings';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  isMarketplaceCategory,
  MARKETPLACE_CATEGORY_LABELS,
} from '~/server/services/blocks/marketplace-categories.constants';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import { trpc } from '~/utils/trpc';

/**
 * Unified listing detail — "More in <category>" DISCOVERY RAIL + a persistent
 * "Browse all apps" link back to `/apps`.
 *
 * Reads the EXISTING `appListings.listAvailable` (category filter + sort) —
 * there is deliberately NO new tRPC procedure and no server schema change for
 * this. Two queries at most:
 *   1. same-category, `sort: 'popular'` — fired only when the listing HAS a
 *      category;
 *   2. all-apps `sort: 'popular'` — fired ONLY when (1) can't fill the rail
 *      (`needsPopularTopUp`), because several categories hold one or two
 *      approved listings today and a one-card rail reads as broken. When the
 *      listing has no category at all, (2) is the only query.
 * Selection (exclude-self, category-then-top-up, cap) lives in the PURE
 * `relatedListings.ts` module so the blocking `unit` gate covers it.
 *
 * The "Browse all apps" link is rendered UNCONDITIONALLY — including while the
 * queries load and when the rail resolves to nothing — so the detail page always
 * offers a way back into the store.
 */

function categoryLabel(category: string | null): string | null {
  if (!category) return null;
  return isMarketplaceCategory(category) ? MARKETPLACE_CATEGORY_LABELS[category] : category;
}

export interface RelatedListingsProps {
  /** The listing being viewed — excluded from the rail. */
  listingId: string;
  category: string | null;
}

export function RelatedListings({ listingId, category }: RelatedListingsProps) {
  const features = useFeatureFlags();
  // Same store-visibility gate the grid + detail use (`appListings` OR-falling-
  // back to `appBlocks`), so this rail can never fire a read the page itself
  // isn't allowed to make.
  const canSeeStore = !!(features.appListings || features.appBlocks);

  // The DTO's `category` is a free-text column (`string | null`), while the
  // query input is the closed taxonomy enum. Narrow through the shared type
  // guard — an unknown/legacy category value degrades to "no category filter"
  // (all-popular rail) instead of sending a value the input would reject.
  const categoryFilter = isMarketplaceCategory(category) ? category : undefined;

  const categoryQuery = trpc.appListings.listAvailable.useQuery(
    { category: categoryFilter, sort: 'popular', limit: RELATED_LISTINGS_LIMIT + 1 },
    { enabled: canSeeStore && !!categoryFilter }
  );
  const sameCategory = (categoryQuery.data?.items ?? []) as ListingCard[];

  const wantTopUp =
    !categoryFilter ||
    needsPopularTopUp({
      selfId: listingId,
      sameCategory,
      categoryLoading: categoryQuery.isLoading,
    });

  const popularQuery = trpc.appListings.listAvailable.useQuery(
    { sort: 'popular', limit: RELATED_LISTINGS_LIMIT + 1 },
    { enabled: canSeeStore && wantTopUp }
  );

  const items = selectRelatedListings({
    selfId: listingId,
    sameCategory,
    popular: (popularQuery.data?.items ?? []) as ListingCard[],
  });

  const label = categoryLabel(category);
  const heading = label ? `More in ${label}` : 'More apps';
  const loading =
    (!!categoryFilter && categoryQuery.isLoading) || (wantTopUp && popularQuery.isLoading);

  return (
    <Stack gap="xs" component="section" aria-label={heading} data-testid="apps-related-rail">
      <Group justify="space-between" align="center">
        <Title order={4}>{heading}</Title>
        {/* Persistent store link — always rendered, even with an empty rail. */}
        <Anchor component={Link} href="/apps" size="sm" data-testid="apps-browse-all">
          <Group gap={4}>
            <IconLayoutGrid size={14} />
            Browse all apps
          </Group>
        </Anchor>
      </Group>

      {loading ? (
        <Center py="md">
          <Loader size="sm" />
        </Center>
      ) : items.length === 0 ? (
        <Text size="sm" c="dimmed">
          No other apps to show yet.
        </Text>
      ) : (
        <Grid gutter="md">
          {items.map((card) => (
            <Grid.Col
              key={card.id}
              span={{ base: 12, sm: 6, md: 4, lg: 4 }}
              data-testid="apps-related-grid-col"
            >
              <AppListingCard card={card} canOpenPage={!!features.appBlocksPages} />
            </Grid.Col>
          ))}
        </Grid>
      )}
    </Stack>
  );
}
