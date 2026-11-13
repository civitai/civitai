import { Alert, Badge, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { isMatureContentRating } from '~/server/utils/server-domain';
import { offsiteContentRatingLabel } from '~/shared/constants/browsingLevel.constants';
import {
  assetRating,
  describeRatingAssets,
  listingRatingAssetsFromView,
  MATURE_STORE_HOST,
  SFW_STORE_HOST,
  summarizeListingRating,
  type ListingRatingDisplayAsset,
} from '~/shared/utils/listing-rating-display';
import { ratingFloorAssets } from '~/shared/utils/listing-media-split';
import { trpc } from '~/utils/trpc';

const ratingLabel = (rating: string | null) => (rating ? offsiteContentRatingLabel(rating) : '—');

/** The listing rating one image requires. Renders nothing until the image has a level. */
export function AssetRatingBadge({
  nsfwLevel,
  testId,
}: {
  nsfwLevel: number | null | undefined;
  testId: string;
}) {
  const rating = assetRating(nsfwLevel);
  if (!rating) return null;
  return (
    <Badge
      size="xs"
      variant="light"
      color={isMatureContentRating(rating) ? 'red' : 'gray'}
      data-testid={testId}
    >
      Rated {offsiteContentRatingLabel(rating)}
    </Badge>
  );
}

/** The moderator-facing "imagery is rated above the app" alert, naming the images behind it. */
export function RatingMismatchAlert({
  testId,
  drivingAssets,
  children,
}: {
  testId: string;
  drivingAssets: ListingRatingDisplayAsset[];
  children: ReactNode;
}) {
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} data-testid={testId}>
      {children}
      {drivingAssets.length > 0 && (
        <Text size="sm" mt={4} data-testid={`${testId}-assets`}>
          Rated highest: {describeRatingAssets(drivingAssets)}.
        </Text>
      )}
    </Alert>
  );
}

/** Warns that approving will raise the listing above its declared rating, naming the images. */
export function OnsiteApproveRatingWarning({
  listingId,
  declaredRating,
  mediaSplit = false,
}: {
  listingId: string;
  declaredRating: string | null;
  /** The moderator chose a media split, so only the civitai.com-eligible images floor the rating. */
  mediaSplit?: boolean;
}) {
  // Always re-read: the author can swap an image between two opens of the same request.
  const { data, isError } = trpc.appListings.getAssets.useQuery(
    { listingId },
    { staleTime: 0, refetchOnMount: 'always', retry: false }
  );
  if (isError)
    return (
      <Text size="xs" c="dimmed" data-testid="apps-onsite-rating-unchecked">
        Could not load the listing’s image ratings, so approve is unavailable. Close and reopen this
        request to retry.
      </Text>
    );
  if (!data)
    return (
      <Text size="xs" c="dimmed" data-testid="apps-onsite-rating-checking">
        Checking the listing’s image ratings…
      </Text>
    );
  const { derived, projected, drivingAssets } = summarizeListingRating({
    declaredRating,
    assets: ratingFloorAssets(listingRatingAssetsFromView(data), mediaSplit),
  });
  if (!projected.raised) return null;
  return (
    <RatingMismatchAlert testId="apps-onsite-rating-mismatch" drivingAssets={drivingAssets}>
      <Text size="sm">
        Store imagery is rated higher ({ratingLabel(derived)}) than the app’s declared rating (
        {ratingLabel(declaredRating)}). Approving raises the store listing to{' '}
        {ratingLabel(projected.rating)}
        {projected.hiddenOnSfw
          ? `, which hides it from the ${SFW_STORE_HOST} marketplace (it stays visible on ${MATURE_STORE_HOST})`
          : ''}
        . If the app itself is not that mature, reject and ask the author to replace the image.
        {data.hasPendingScan || data.hasBlockedAsset
          ? ' The listing only goes live once all of its media has scanned clean.'
          : ''}
      </Text>
    </RatingMismatchAlert>
  );
}

/**
 * Where the listing being edited stands, which decides what a higher-rated image does:
 *   - `live-revision` — approved; the edits are staged as a revision, whose review cannot
 *     raise the listing's rating.
 *   - `live-direct`   — approved and edited in place (a moderator), with no review to follow.
 *   - `was-live`      — out of the store after being live (reset to pending, or unpublished);
 *     going live again keeps at least its current rating.
 *   - `not-live`      — never live; going live rates it from the declared rating and its
 *     images, so its current rating is not kept.
 */
export type ListingRatingStage = 'live-revision' | 'live-direct' | 'was-live' | 'not-live';

/**
 * The author-facing explanation in the media editor: which images put the listing above
 * the rating they declared, what that does to its visibility, and what to do about it.
 */
export function ListingMediaRatingCallout({
  declaredRating,
  listingRating,
  stage,
  assets,
}: {
  declaredRating: string | null;
  listingRating: string | null;
  stage: ListingRatingStage;
  assets: ListingRatingDisplayAsset[];
}) {
  const {
    current,
    projected,
    drivingAssets,
    projectedExceedsCurrent,
    currentExceedsProjected,
    allAssetsRated,
  } = summarizeListingRating({ declaredRating, listingRating, assets });
  const stores = `${SFW_STORE_HOST} (visible on ${MATURE_STORE_HOST})`;
  const live = stage === 'live-revision' || stage === 'live-direct';
  const hidden = live ? `is hidden on ${stores}` : `will be hidden on ${stores} once it is live`;

  if (drivingAssets.length > 0) {
    const consequence = currentExceedsProjected
      ? `This listing is rated ${ratingLabel(current.rating)}${
          current.hiddenOnSfw ? ` and ${hidden}` : ''
        }, higher still than its images require.`
      : !projectedExceedsCurrent
      ? `That is why this listing is rated ${ratingLabel(current.rating)}${
          current.hiddenOnSfw ? ` and ${hidden}` : ''
        }.`
      : stage === 'live-revision'
      ? `This listing is live and rated ${ratingLabel(
          current.rating
        )}; image changes to a live listing cannot raise its rating, so a moderator will send back a change that includes this image.`
      : stage === 'live-direct'
      ? `This listing is live and still rated ${ratingLabel(current.rating)}, below this image.`
      : `When this listing goes live it will be rated ${ratingLabel(projected.rating)}${
          projected.hiddenOnSfw ? ` and hidden on ${stores}` : ''
        }.`;
    return (
      <Alert
        color={current.hiddenOnSfw || projected.hiddenOnSfw ? 'red' : 'yellow'}
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        data-testid="apps-listing-rating-callout"
      >
        <Text size="sm">
          {describeRatingAssets(drivingAssets)} {drivingAssets.length === 1 ? 'is' : 'are'} rated
          above the {ratingLabel(declaredRating)} you declared for this app. A listing is never
          rated lower than its most mature image. {consequence}{' '}
          {currentExceedsProjected
            ? 'Ask a moderator to review the listing’s rating.'
            : projectedExceedsCurrent || stage === 'not-live'
            ? drivingAssets.length === 1
              ? 'Replacing that image avoids this.'
              : 'Replacing those images avoids this.'
            : drivingAssets.length === 1
            ? 'Replacing that image alone will not lower the listing’s rating; ask a moderator to review that image’s rating.'
            : 'Replacing those images alone will not lower the listing’s rating; ask a moderator to review their ratings.'}
        </Text>
      </Alert>
    );
  }

  // Only claimable once every image has a level: an unrated one could still be the cause.
  if (current.raised && declaredRating != null && allAssetsRated) {
    return (
      <Alert
        color={current.hiddenOnSfw ? 'red' : 'yellow'}
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        data-testid="apps-listing-rating-stale"
      >
        <Text size="sm">
          This listing is rated {ratingLabel(current.rating)}, above the{' '}
          {ratingLabel(declaredRating)} you declared
          {current.hiddenOnSfw ? `, and ${hidden}` : ''} — but none of its current images is rated
          that high. Ask a moderator to review the listing’s rating.
        </Text>
      </Alert>
    );
  }
  return null;
}
