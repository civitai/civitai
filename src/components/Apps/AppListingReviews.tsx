import { Badge, Button, Divider, Group, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import { useMemo } from 'react';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { AppListingReviewListItem } from '~/server/schema/blocks/app-listing-review.schema';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — the recent-reviews LIST for a store listing (thumbs
 * / recommend). Keyset/infinite over `appListings.listReviews` (which already
 * filters mod-excluded / tos-violation rows). Renders `details` as ESCAPED PLAIN
 * TEXT via React's default escaping — NEVER dangerouslySetInnerHTML (`details` is
 * only length-capped/trimmed server-side, so the escaping is the XSS control).
 *
 * DARK: mounted only under the mod-only store-preview detail body today.
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
          <ReviewRow review={review} isViewer={review.user?.id === currentUser?.id} />
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

function ReviewRow({
  review,
  isViewer,
}: {
  review: AppListingReviewListItem;
  isViewer: boolean;
}) {
  return (
    <Group align="flex-start" wrap="nowrap" gap="sm">
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" align="center" wrap="wrap">
          {review.user ? (
            <UserAvatar userId={review.user.id} size="sm" withUsername linkToProfile />
          ) : (
            <Text size="sm" c="dimmed">
              [deleted]
            </Text>
          )}
          {isViewer && (
            <Badge size="xs" variant="light" color="blue">
              Your review
            </Badge>
          )}
          <Text c="dimmed" size="xs">
            <DaysFromNow date={review.createdAt} />
          </Text>
        </Group>
        {review.recommended ? (
          <Group gap={4} align="center">
            <ThemeIcon variant="light" color="green" size="sm" radius="xl">
              <IconThumbUp size={12} />
            </ThemeIcon>
            <Text size="xs" c="green">
              Recommends
            </Text>
          </Group>
        ) : (
          <Group gap={4} align="center">
            <ThemeIcon variant="light" color="red" size="sm" radius="xl">
              <IconThumbDown size={12} />
            </ThemeIcon>
            <Text size="xs" c="red">
              Doesn&apos;t recommend
            </Text>
          </Group>
        )}
        {/* PLAIN TEXT ONLY — React escapes this. NEVER dangerouslySetInnerHTML. */}
        {review.details && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {review.details}
          </Text>
        )}
      </Stack>
    </Group>
  );
}
