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
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              Cover
            </Text>
            <ListingCoverThumb
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

      {/* The same viewer the queue opens, so the two surfaces cannot drift on prev/next or
          on the broken-shot rescue. */}
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
