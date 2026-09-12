import { Anchor, Divider, Group, Stack, Title } from '@mantine/core';
import { IconArrowDown } from '@tabler/icons-react';

import { AppListingReviewRow } from '~/components/Apps/AppListingReviewRow';
import { LISTING_REVIEWS_ANCHOR_ID } from '~/components/Apps/listingKindLabels';
import { INLINE_RECENT_REVIEWS_LIMIT, selectRecentReviews } from '~/components/Apps/recent-reviews';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — the BOUNDED inline recent-reviews block, rendered
 * full-width between the listing description and the "More in <category>"
 * discovery rail.
 *
 * ## What this is, and what it deliberately is not
 *
 * A tester asked for reviews "right below description, show 3-4 recent + a 'See
 * more reviews' link", and separately for the discovery rail to move to the very
 * bottom. The rail did NOT move: its placement comment in
 * `AppListingDetailBody.tsx` explains that it sits above the unbounded threads
 * precisely so it is not buried, and that reasoning still holds. This block is
 * what made honouring the first request compatible with keeping the second
 * unchanged — it is FIXED-HEIGHT, so it cannot push the rail down by an
 * arbitrary amount the way hoisting the full list would have.
 *
 * 🔴 THAT BOUND IS THE DESIGN. The cap lives in `recent-reviews.ts` and is
 * applied to the RENDER as well as to the query `limit`, so neither a server
 * that returns more nor a future edit that asks for more can quietly widen the
 * block. `recentReviews.test.ts` (node `unit` tier — blocking) asserts it
 * against an over-long input.
 *
 * ## Reuse, not a second renderer
 *
 * Rows go through the shared `AppListingReviewRow`, the same component the full
 * `AppListingReviews` list uses, so the two surfaces cannot drift in how a
 * review is presented or — the part that matters — in `details` being rendered
 * as ESCAPED PLAIN TEXT. The only difference is the query: a plain bounded
 * `useQuery` here versus the full list's `useInfiniteQuery`, because this block
 * has no "load more" by construction. `appListings.listReviews` already accepts
 * a `limit`, so this needed no server change.
 *
 * ## Nothing to show ⇒ nothing rendered
 *
 * 🔴 Returns `null` while loading AND when there are no reviews — no heading, no
 * skeleton, no "be the first to review" placeholder. The full list at the bottom
 * of the page still says that; saying it twice on one page, once in a box that
 * pushed the rail down, is worse than not having the block. Convention per
 * #4761 and the neighbouring permissions/disclosure sections.
 */
export function AppListingRecentReviews({ appListingId }: { appListingId: string }) {
  const currentUser = useCurrentUser();

  // Bounded, NON-infinite. The same procedure the full list pages through; the
  // `limit` is the shared constant, so the network ask and the render bound are
  // one number.
  const { data, isLoading } = trpc.appListings.listReviews.useQuery({
    appListingId,
    limit: INLINE_RECENT_REVIEWS_LIMIT,
  });

  const reviews = selectRecentReviews(data?.items);

  // 🔴 Loading renders NOTHING rather than a skeleton: a placeholder here would
  // reserve height above the discovery rail for a block that may never appear,
  // which is the exact reflow this shape exists to avoid.
  if (isLoading || reviews.length === 0) return null;

  return (
    <>
      <Divider />
      <Stack
        gap="md"
        component="section"
        aria-label="Recent reviews"
        data-testid="apps-listing-recent-reviews"
      >
        <Group justify="space-between" align="center">
          <Title order={4}>Recent reviews</Title>
          {/* 🔴 The SAME constant the full section's `id` is built from — never a
              second `'app-listing-reviews'` literal. A fragment link to a missing
              id is inert with no error, so the only thing keeping this honest is
              that both ends read one value. Pinned by
              `AppListingDetailBody.recentReviews.browser.test.tsx`. */}
          <Anchor
            href={`#${LISTING_REVIEWS_ANCHOR_ID}`}
            size="sm"
            underline="always"
            data-testid="apps-listing-see-more-reviews"
          >
            <Group gap={4}>
              <IconArrowDown size={14} />
              See more reviews
            </Group>
          </Anchor>
        </Group>

        {reviews.map((review) => (
          <AppListingReviewRow
            key={review.id}
            review={review}
            isViewer={review.user?.id === currentUser?.id}
          />
        ))}
      </Stack>
    </>
  );
}
