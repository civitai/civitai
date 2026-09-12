import { Button, Divider, Group, Loader, Stack, Text } from '@mantine/core';
import { useMemo } from 'react';

import { AppListingReviewRow } from '~/components/Apps/AppListingReviewRow';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — the FULL reviews list for a store listing (thumbs /
 * recommend). Keyset/infinite over `appListings.listReviews` (which already
 * filters mod-excluded / tos-violation rows).
 *
 * 🔴 Rows render through the SHARED `AppListingReviewRow`, which the bounded
 * inline block (`AppListingRecentReviews`, below the description) also uses — so
 * the two surfaces cannot drift, and in particular `details` is escaped plain
 * text in exactly one place. NEVER dangerouslySetInnerHTML: `details` is only
 * length-capped/trimmed server-side, so the escaping is the XSS control.
 *
 * This is the list the page's `LISTING_REVIEWS_ANCHOR_ID` section wraps, and it
 * stays at the BOTTOM of the detail page — the inline block links down to it.
 */
export function AppListingReviews({ appListingId }: { appListingId: string }) {
  const currentUser = useCurrentUser();
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.appListings.listReviews.useInfiniteQuery(
      { appListingId },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  if (isLoading) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  }

  if (items.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        Be the first to review this app.
      </Text>
    );
  }

  return (
    <Stack gap="md">
      {items.map((review) => (
        <div key={review.id}>
          <AppListingReviewRow review={review} isViewer={review.user?.id === currentUser?.id} />
          <Divider mt="md" />
        </div>
      ))}
      {hasNextPage && (
        <Group justify="center">
          <Button variant="default" onClick={() => fetchNextPage()} loading={isFetchingNextPage}>
            Load more
          </Button>
        </Group>
      )}
    </Stack>
  );
}
