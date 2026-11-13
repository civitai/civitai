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
import { ReviewMediaReveal } from '~/components/Apps/ReviewMediaReveal';
import { reviewMediaNeedsReveal } from '~/components/Apps/reviewMediaRevealRule';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  ListingReviewImage,
  ListingReviewMedia,
} from '~/server/services/blocks/app-listing.service';
import { ListingAudienceBadge } from '~/components/Apps/ListingAudienceBadge';
import { listingRatingAssetLabel } from '~/shared/utils/listing-rating-display';

/**
 * Where one listing image shows, as a badge (`ListingAudienceBadge`). `rating` is the listing
 * rating it is judged against; without one, the widest civitai.com rating (`pg13`), so the label
 * says only whether civitai.com could show the image at all.
 */
export function ReviewMediaAudienceBadge({
  image,
  redSlot,
  rating,
  testId,
}: {
  image: Pick<ListingReviewImage, 'nsfwLevel'> | null | undefined;
  redSlot?: boolean;
  rating?: string | null;
  testId: string;
}) {
  if (!image) return null;
  return (
    <ListingAudienceBadge
      asset={{ nsfwLevel: image.nsfwLevel, redSlot }}
      rating={rating ?? 'pg13'}
      testId={testId}
    />
  );
}

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
 * CLICK-TO-REVEAL AND AUDIENCES (`reviewMedia`). Given the moderator's per-image facts, an image
 * rated R, X or XXX is held behind `ReviewMediaReveal` on civitai.com until clicked, every image
 * carries a badge saying where it shows, and the civitai.red icon / cover overrides get their own
 * tiles (labelled civitai.red only — civitai.com never shows them, whatever their level). The
 * off-site / listing-media review modal renders this card too, from its preview read.
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
  reviewMedia,
  rating,
}: {
  slug: string;
  /** Display name for the viewer's captions and the thumbnails' accessible names. */
  name: string;
  iconUrl: string | null;
  coverUrl: string | null;
  /**
   * The same icon and cover with their levels, plus the civitai.red overrides. With it, an
   * above-SFW image is held behind a click-to-reveal on civitai.com (`ReviewMediaReveal`) and
   * every image carries where it shows; without it, the two thumbnails render as before.
   */
  reviewMedia?: ListingReviewMedia | null;
  /** The listing rating the audience badges are judged against (see `ReviewMediaAudienceBadge`). */
  rating?: string | null;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const [broken, setBroken] = useState<BrokenScreenshotIndexes>(NO_BROKEN_SCREENSHOTS);
  const features = useOptionalFeatureFlags();
  // 🔴 THE LIGHTBOX NEVER SHOWS AN IMAGE THE REVEAL IS HOLDING BACK. The viewer below is a
  // separate full-size surface the reveal does not wrap, and it navigates between the two images
  // — so opening the SFW icon and pressing ← would otherwise show a blurred mature cover
  // full-size. Such an image is left out of the viewer (and its thumbnail opens nothing); it is
  // judged at review size behind its reveal.
  const viewable = (image: ListingReviewImage | null | undefined) =>
    !image || !reviewMediaNeedsReveal(features?.canViewNsfw, image.nsfwLevel);
  const row = {
    name,
    iconUrl: viewable(reviewMedia?.icon) ? iconUrl : null,
    coverUrl: viewable(reviewMedia?.cover) ? coverUrl : null,
  };

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
            <ReviewMediaReveal
              image={reviewMedia?.icon}
              testId={`apps-review-listing-icon-reveal-${slug}`}
            >
              <ListingIconThumb
                size="review"
                url={iconUrl}
                name={name}
                imgTestId={`apps-review-listing-icon-${slug}`}
                placeholderTestId={`apps-review-listing-icon-placeholder-${slug}`}
                onOpen={row.iconUrl ? () => open('icon') : undefined}
                buttonTestId={`apps-review-listing-icon-button-${slug}`}
              />
            </ReviewMediaReveal>
            <ReviewMediaAudienceBadge
              image={reviewMedia?.icon}
              rating={rating}
              testId={`apps-review-listing-icon-audience-${slug}`}
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
            <ReviewMediaReveal
              image={reviewMedia?.cover}
              testId={`apps-review-listing-cover-reveal-${slug}`}
            >
              <ListingCoverThumb
                size="review"
                url={coverUrl}
                name={name}
                imgTestId={`apps-review-listing-cover-${slug}`}
                placeholderTestId={`apps-review-listing-cover-placeholder-${slug}`}
                onOpen={row.coverUrl ? () => open('cover') : undefined}
                buttonTestId={`apps-review-listing-cover-button-${slug}`}
              />
            </ReviewMediaReveal>
            <ReviewMediaAudienceBadge
              image={reviewMedia?.cover}
              rating={rating}
              testId={`apps-review-listing-cover-audience-${slug}`}
            />
            {!coverUrl && (
              <Text size="xs" c="orange" data-testid={`apps-review-listing-no-cover-${slug}`}>
                No cover
              </Text>
            )}
          </Stack>
          {/* The civitai.red overrides, only when set: shown instead of the icon / cover on
              civitai.red alone, so they are labelled as such whatever their level. */}
          {reviewMedia?.redIcon && (
            <Stack gap={4}>
              <Text size="xs" c="dimmed">
                {listingRatingAssetLabel({ kind: 'red-icon', nsfwLevel: null })}
              </Text>
              <ReviewMediaReveal
                image={reviewMedia.redIcon}
                testId={`apps-review-listing-red-icon-reveal-${slug}`}
              >
                <ListingIconThumb
                  size="review"
                  url={reviewMedia.redIcon.url}
                  name={name}
                  imgTestId={`apps-review-listing-red-icon-${slug}`}
                  placeholderTestId={`apps-review-listing-red-icon-placeholder-${slug}`}
                />
              </ReviewMediaReveal>
              <ReviewMediaAudienceBadge
                image={reviewMedia.redIcon}
                redSlot
                testId={`apps-review-listing-red-icon-audience-${slug}`}
              />
            </Stack>
          )}
          {reviewMedia?.redCover && (
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Text size="xs" c="dimmed">
                {listingRatingAssetLabel({ kind: 'red-cover', nsfwLevel: null })}
              </Text>
              <ReviewMediaReveal
                image={reviewMedia.redCover}
                testId={`apps-review-listing-red-cover-reveal-${slug}`}
              >
                <ListingCoverThumb
                  size="review"
                  url={reviewMedia.redCover.url}
                  name={name}
                  imgTestId={`apps-review-listing-red-cover-${slug}`}
                  placeholderTestId={`apps-review-listing-red-cover-placeholder-${slug}`}
                />
              </ReviewMediaReveal>
              <ReviewMediaAudienceBadge
                image={reviewMedia.redCover}
                redSlot
                testId={`apps-review-listing-red-cover-audience-${slug}`}
              />
            </Stack>
          )}
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
