import { Button, Center, Grid, Loader, Stack, Text } from '@mantine/core';
import { AppListingCard } from '~/components/Apps/AppListingCard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { onlyListingCards } from '~/shared/constants/app-sub-listing.constants';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { trpc } from '~/utils/trpc';

/** Page size for the profile Apps tab; inside the server's cap of 50. */
const USER_APPS_PAGE = 24;

/**
 * One developer's store listings, for the profile Apps tab. Reads `appListings.listAvailable`
 * with `userId`, so it shows exactly the developer's apps this viewer could find in the `/apps`
 * store (the store predicate, server-side) — and the same set the listing page's
 * "More by this developer" rail and track-record line count.
 */
export function UserAppsGrid({ userId }: { userId: number }) {
  const features = useFeatureFlags();
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.appListings.listAvailable.useInfiniteQuery(
      { userId, sort: 'popular', limit: USER_APPS_PAGE },
      {
        enabled: hasAppsStoreAccess(features),
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  if (isLoading)
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  if (isError)
    return (
      <Center py="xl">
        <Text c="dimmed">Couldn&apos;t load apps.</Text>
      </Center>
    );

  // Drops sub-listing cards: `AppListingCard` throws on them (none are requested here).
  const cards = onlyListingCards(data?.pages.flatMap((p) => p.items) ?? []);
  if (cards.length === 0)
    return (
      <Center py="xl">
        <Text c="dimmed" data-testid="user-apps-empty">
          No apps yet.
        </Text>
      </Center>
    );

  return (
    <Stack gap="lg" data-testid="user-apps-grid">
      <Grid gutter="md">
        {cards.map((card) => (
          <Grid.Col key={card.id} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
            <AppListingCard card={card} canOpenPage={!!features.appBlocksPages} />
          </Grid.Col>
        ))}
      </Grid>
      {hasNextPage && (
        <Center>
          <Button variant="default" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
            Load more
          </Button>
        </Center>
      )}
    </Stack>
  );
}
