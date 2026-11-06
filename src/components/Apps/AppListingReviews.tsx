import { Badge, Button, Divider, Group, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { AppListingReviewListItem } from '~/server/schema/blocks/app-listing-review.schema';
import { trpc } from '~/utils/trpc';

/** Reviews shown before "Show all reviews", so a long thread does not bury the rest of the page. */
const COLLAPSED_REVIEW_COUNT = 4;

/**
 * App Store Listings (W13) — the recent-reviews LIST for a store listing (thumbs
 * / recommend). Keyset/infinite over `appListings.listReviews` (which already
 * filters mod-excluded / tos-violation rows). Renders `details` as ESCAPED PLAIN
 * TEXT via React's default escaping — NEVER dangerouslySetInnerHTML (`details` is
 * only length-capped/trimmed server-side, so the escaping is the XSS control).
 *
 * Not mounted in preview: a shadow listing has no reviews.
 */
export function AppListingReviews({
  appListingId,
  onLeaveReview,
}: {
  appListingId: string;
  /**
   * Opens the caller's review modal. Pass it ONLY for a viewer `useCanReviewListing`
   * admits — this component applies no gate; without it the empty state stays plain text.
   */
  onLeaveReview?: () => void;
}) {
  const currentUser = useCurrentUser();
  // Keyed by listing so a client-side navigation to another app (body stays mounted) starts collapsed.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = expandedFor === appListingId;
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.appListings.listReviews.useInfiniteQuery(
      { appListingId },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const visible = expanded ? items : items.slice(0, COLLAPSED_REVIEW_COUNT);
  const hasHidden =
    items.length > COLLAPSED_REVIEW_COUNT ||
    (!!hasNextPage && items.length === COLLAPSED_REVIEW_COUNT);
  // Collapsed, keep paging only until there is a full first screen to show.
  const canLoadMore = !!hasNextPage && (expanded || items.length < COLLAPSED_REVIEW_COUNT);

  if (isLoading) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  }

  if (items.length === 0) {
    // For an eligible viewer the empty-state copy IS the call to action.
    if (onLeaveReview) {
      return (
        <Group>
          <Button
            variant="subtle"
            size="compact-sm"
            px={0}
            leftSection={<IconThumbUp size={14} />}
            onClick={onLeaveReview}
            data-testid="apps-listing-reviews-empty-cta"
          >
            Be the first to review this app.
          </Button>
        </Group>
      );
    }
    return (
      <Text c="dimmed" size="sm">
        Be the first to review this app.
      </Text>
    );
  }

  return (
    <Stack gap="md">
      {visible.map((review) => (
        <div key={review.id}>
          <ReviewRow review={review} isViewer={review.user?.id === currentUser?.id} />
          <Divider mt="md" />
        </div>
      ))}
      {!expanded && hasHidden && (
        <Group justify="center">
          <Button variant="light" onClick={() => setExpandedFor(appListingId)}>
            Show all reviews
          </Button>
        </Group>
      )}
      {canLoadMore && (
        <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetchingNextPage}>
          <Group justify="center" data-testid="apps-reviews-loading-more">
            <Loader size="sm" />
          </Group>
        </InViewLoader>
      )}
    </Stack>
  );
}

function ReviewRow({ review, isViewer }: { review: AppListingReviewListItem; isViewer: boolean }) {
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
