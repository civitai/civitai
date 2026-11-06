import { Anchor, Center, Grid, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconLayoutGrid } from '@tabler/icons-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppListingCard } from '~/components/Apps/AppListingCard';
import {
  isRelatedRailLoading,
  needsPopularTopUp,
  RELATED_LISTINGS_LIMIT,
  relatedRailHeading,
  relatedRailSections,
} from '~/components/Apps/related-listings';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import { onlyListingCards } from '~/shared/constants/app-sub-listing.constants';
import { APPS_STORE_HREF } from '~/shared/constants/apps-routes.constants';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
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
 * Selection (exclude-self, category-then-top-up, cap) and the headings live in the
 * PURE `related-listings.ts` module so the blocking `unit` gate covers them. The
 * top-up renders as its own "Popular apps" group: it is drawn from every category,
 * so it never sits under the "More in <category>" heading.
 *
 * The "Browse all apps" link is rendered UNCONDITIONALLY — including while the
 * queries load and when the rail resolves to nothing — so the detail page always
 * offers a way back into the store.
 */

export interface RelatedListingsProps {
  /** The listing being viewed — excluded from the rail. */
  listingId: string;
  category: string | null;
}

/**
 * The rail's data: its sections and whether it is still loading. Shared by the rail and by
 * the Details panel's link to it, so both read ONE answer. Both callers pass the same inputs,
 * so React Query serves them from the same two queries (no extra request).
 */
export function useRelatedRail({ listingId, category }: RelatedListingsProps) {
  const features = useFeatureFlags();
  // Same store-visibility gate the grid + detail use — the SHARED
  // `hasAppsStoreAccess` predicate — so this rail can never fire a read the page
  // itself isn't allowed to make.
  const canSeeStore = hasAppsStoreAccess(features);

  // The DTO's `category` is a free-text column (`string | null`), while the
  // query input is the closed taxonomy enum. Narrow through the shared type
  // guard — an unknown/legacy category value degrades to "no category filter"
  // (all-popular rail) instead of sending a value the input would reject.
  const categoryFilter = isMarketplaceCategory(category) ? category : undefined;

  const categoryQuery = trpc.appListings.listAvailable.useQuery(
    { category: categoryFilter, sort: 'popular', limit: RELATED_LISTINGS_LIMIT + 1 },
    { enabled: canSeeStore && !!categoryFilter }
  );
  // Drops sub-listing cards: `AppListingCard` throws on them.
  const sameCategory = onlyListingCards(categoryQuery.data?.items ?? []);

  const wantTopUp =
    !categoryFilter ||
    needsPopularTopUp({
      selfId: listingId,
      sameCategory,
      // `isPending` (not `isLoading`) — see `isRelatedRailLoading`. A disabled
      // query is permanently pending, hence the `!!categoryFilter` guard.
      categoryLoading: !!categoryFilter && categoryQuery.isPending,
    });

  const popularQuery = trpc.appListings.listAvailable.useQuery(
    { sort: 'popular', limit: RELATED_LISTINGS_LIMIT + 1 },
    { enabled: canSeeStore && wantTopUp }
  );

  const sections = relatedRailSections({
    selfId: listingId,
    category: categoryFilter ?? null,
    sameCategory,
    popular: onlyListingCards(popularQuery.data?.items ?? []),
  });

  const loading = isRelatedRailLoading({
    hasCategoryFilter: !!categoryFilter,
    categoryPending: categoryQuery.isPending,
    wantTopUp,
    popularPending: popularQuery.isPending,
  });

  return { sections, loading, canOpenPage: !!features.appBlocksPages };
}

export function RelatedListings({ listingId, category }: RelatedListingsProps) {
  const { sections, loading, canOpenPage } = useRelatedRail({ listingId, category });

  // Persistent store link — always rendered, even with an empty rail. It sits beside the
  // FIRST heading on screen, whichever group that is.
  const headerRow = (heading: string) => (
    <Group justify="space-between" align="center">
      <Title order={4}>{heading}</Title>
      <Anchor component={Link} href={APPS_STORE_HREF} size="sm" data-testid="apps-browse-all">
        <Group gap={4}>
          <IconLayoutGrid size={14} />
          Browse all apps
        </Group>
      </Anchor>
    </Group>
  );

  let body: ReactNode;
  if (loading || sections.length === 0) {
    body = (
      <>
        {/* 🔴 From the PURE module, so the blocking `unit` gate covers the one string on
            this surface that a reader actually sees the category in. */}
        {/* Over an empty rail this IS `relatedRailFirstHeading`'s answer, which the
            Details panel's link reads. */}
        {headerRow(relatedRailHeading(category))}
        {loading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : (
          <Text size="sm" c="dimmed">
            No other apps to show yet.
          </Text>
        )}
      </>
    );
  } else {
    body = sections.map((section, i) => (
      <Stack
        key={section.key}
        gap="xs"
        component="section"
        aria-label={section.heading}
        data-testid={`apps-related-section-${section.key}`}
      >
        {i === 0 ? headerRow(section.heading) : <Title order={4}>{section.heading}</Title>}
        <Grid gutter="md">
          {section.items.map((card) => (
            <Grid.Col
              key={card.id}
              span={{ base: 12, sm: 6, md: 4, lg: 4 }}
              data-testid="apps-related-grid-col"
            >
              <AppListingCard card={card} canOpenPage={canOpenPage} />
            </Grid.Col>
          ))}
        </Grid>
      </Stack>
    ));
  }

  return (
    <Stack gap="lg" component="section" aria-label="Related apps" data-testid="apps-related-rail">
      {body}
    </Stack>
  );
}
