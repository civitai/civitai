import { Badge, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { AppListingReviewListItem } from '~/server/schema/blocks/app-listing-review.schema';

/**
 * App Store Listings (W13) — the ONE review row renderer.
 *
 * Extracted from `AppListingReviews` so the bounded inline block
 * (`AppListingRecentReviews`, below the description) and the full paginated list
 * (`AppListingReviews`, at the bottom of the page) render a review IDENTICALLY.
 * They differ only in how many rows they ask for and what surrounds them; a
 * second renderer would let the two drift — one gaining a moderation affordance
 * or a truncation the other lacks — with nothing observing the divergence.
 *
 * 🔴 `details` is ESCAPED PLAIN TEXT via React's default escaping — NEVER
 * `dangerouslySetInnerHTML`. `details` is only length-capped/trimmed server-side
 * (`LISTING_REVIEW_DETAILS_MAX`), so the escaping IS the XSS control, and it now
 * lives in exactly one place rather than one per list surface.
 *
 * 🔴 Its OWN module, not an export of `AppListingReviews`. Component tests mock
 * `~/components/Apps/AppListingReviews` wholesale to keep the infinite query out
 * of unrelated trees; a row exported from there would vanish under that mock and
 * take the inline block down with it.
 */
export function AppListingReviewRow({
  review,
  isViewer,
}: {
  review: AppListingReviewListItem;
  isViewer: boolean;
}) {
  return (
    <Group align="flex-start" wrap="nowrap" gap="sm" data-testid="apps-listing-review-row">
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
