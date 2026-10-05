import { Card, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { AppListingScreenshotViewer } from '~/components/Apps/AppListingScreenshotViewer';
import {
  NO_BROKEN_SCREENSHOTS,
  withBrokenIndex,
  type BrokenScreenshotIndexes,
} from '~/components/Apps/appListingScreenshotNav';
import { ListingCoverThumb, ListingIconThumb } from '~/components/Apps/ListingMediaThumb';
import { listingMediaIndex, listingMediaShots } from '~/components/Apps/myAppsView';

/**
 * The app's STORE LISTING media, on the per-submission review page.
 *
 * 🔴 THE REVIEW BODY SHOWS *BUNDLE* SCREENSHOTS, WHICH ARE A DIFFERENT SET OF BYTES.
 * `OnsiteReviewModalBody` renders the images extracted from the submitted ZIP; the icon and
 * cover are `AppListing.icon_id`/`cover_id`, authored in the store form and never in the
 * bundle. A moderator approving a first version was therefore approving an app whose store
 * card they had not seen.
 *
 * A pending FIRST version does have a pre-approval draft listing (created at submit), so the
 * media usually exists at review time — but not always, which is why both absences render an
 * explicit state rather than an empty box.
 *
 * 🔴 `size="review"` — THE SAME COMPONENTS, THE BIGGER BOX. These two thumbs are shared with
 * `/apps/mine` and the `/apps/review` queue, where they sit in TABLE ROWS and 40×40 is
 * correct. Here there is one submission on the moderator's whole screen and the question is
 * partly whether this art is acceptable, so the row size was the defect: a thumbnail too
 * small to assess is the same as not showing it. The size is a per-caller variant rather than
 * a change to the shared constants, which would double the height of every queue row.
 *
 * ⚠️ IT RENDERS FOR EVERY MODE. This card is outside the pending-only gates, so an approved
 * or rejected submission still shows its store art for a re-check — the larger box must not
 * assume a decision is pending, and nothing here reads `mode`.
 */
export function ReviewListingMedia({
  slug,
  name,
  iconUrl,
  coverUrl,
}: {
  slug: string;
  /** Display name for the viewer's captions and the thumbnails' accessible names. */
  name: string;
  iconUrl: string | null;
  coverUrl: string | null;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const [broken, setBroken] = useState<BrokenScreenshotIndexes>(NO_BROKEN_SCREENSHOTS);
  const row = { name, iconUrl, coverUrl };

  const open = (which: 'icon' | 'cover') => {
    const next = listingMediaIndex(row, which);
    if (next === null) return;
    setBroken(NO_BROKEN_SCREENSHOTS);
    setIndex(next);
  };

  return (
    <Card withBorder p="md" mb="md" data-testid="apps-review-listing-media">
      <Stack gap="xs">
        <Text fw={600} size="sm">
          Store listing media
        </Text>
        <Group gap="lg" align="flex-start" wrap="wrap">
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              Icon
            </Text>
            <ListingIconThumb
              size="review"
              url={iconUrl}
              name={name}
              imgTestId={`apps-review-listing-icon-${slug}`}
              placeholderTestId={`apps-review-listing-icon-placeholder-${slug}`}
              onOpen={iconUrl ? () => open('icon') : undefined}
              buttonTestId={`apps-review-listing-icon-button-${slug}`}
            />
            {!iconUrl && (
              <Text size="xs" c="orange" data-testid={`apps-review-listing-no-icon-${slug}`}>
                No icon
              </Text>
            )}
          </Stack>
          {/*
            🔴 `minWidth: 0` SO THE NO-COVER CASE GIVES WAY LIKE THE COVER CASE. A flex item's
            automatic minimum size is content-based, and the two branches contribute very
            differently: measured at a 280px viewport, cover present 246px, cover ABSENT 320px
            — i.e. a listing with no cover overflowed the card, which the 96px row box never
            did. `minWidth: 0` lets the Stack shrink, and the placeholder's `max-width: 100%`
            then does the work — the per-branch measurement is on `coverBoxStyle` in
            `ListingMediaThumb.tsx`.
          */}
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Text size="xs" c="dimmed">
              Cover
            </Text>
            <ListingCoverThumb
              size="review"
              url={coverUrl}
              name={name}
              imgTestId={`apps-review-listing-cover-${slug}`}
              placeholderTestId={`apps-review-listing-cover-placeholder-${slug}`}
              onOpen={coverUrl ? () => open('cover') : undefined}
              buttonTestId={`apps-review-listing-cover-button-${slug}`}
            />
            {!coverUrl && (
              <Text size="xs" c="orange" data-testid={`apps-review-listing-no-cover-${slug}`}>
                No cover
              </Text>
            )}
          </Stack>
        </Group>
      </Stack>

      {/* The same viewer the queue opens. */}
      <AppListingScreenshotViewer
        shots={listingMediaShots(row)}
        name={name}
        broken={broken}
        index={index}
        onIndexChange={setIndex}
        onBroken={(i) => setBroken((prev) => withBrokenIndex(prev, i))}
        onClose={() => setIndex(null)}
      />
    </Card>
  );
}
