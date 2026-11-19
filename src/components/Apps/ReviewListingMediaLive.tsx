import type { ComponentProps } from 'react';
import { ReviewListingMedia } from '~/components/Apps/ReviewListingMedia';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type {
  ListingReviewImage,
  ListingReviewMedia,
} from '~/server/services/blocks/app-listing.service';
import type { ListingAssetLevels } from '~/shared/utils/listing-rating-display';
import { trpc } from '~/utils/trpc';

/**
 * Every image id in `assets` mapped to its level, as `appListings.getAssets` reads it now.
 * An image with no level (deleted, not yet scanned) is left out, so it keeps the level it had.
 */
export function liveLevelsById(assets: Partial<ListingAssetLevels> | null | undefined) {
  const levels = new Map<number, number>();
  if (!assets) return levels;
  const add = (id: number | null | undefined, level: number | null | undefined) => {
    if (id != null && level != null) levels.set(id, level);
  };
  add(assets.iconId, assets.iconNsfwLevel);
  add(assets.coverId, assets.coverNsfwLevel);
  add(assets.redIconId, assets.redIconNsfwLevel);
  add(assets.redCoverId, assets.redCoverNsfwLevel);
  for (const shot of assets.screenshots ?? []) add(shot.imageId, shot.nsfwLevel);
  return levels;
}

/** `image` with its level from `levels` when there is one there. */
export function withLiveLevel<T extends ListingReviewImage>(
  image: T | null | undefined,
  levels: Map<number, number>
): T | null {
  if (!image) return null;
  const level = levels.get(image.imageId);
  return level === undefined || level === image.nsfwLevel ? image : { ...image, nsfwLevel: level };
}

type LiveProps = Omit<
  ComponentProps<typeof ReviewListingMedia>,
  'screenshots' | 'rerateListingIds'
> & {
  /** The listing whose media this is (`request.appListingId`). */
  listingId: string | null | undefined;
  /**
   * The listing an approve publishes (`request.approveRating.listingId`), which the approve bar's
   * rating warning reads. Usually the same listing; a re-rate updates both caches either way.
   */
  approveListingId?: string | null;
};

/**
 * `ReviewListingMedia` on the review PAGE, where a moderator can re-rate each image.
 *
 * 🔴 THE LEVELS ARE RE-READ, NOT TAKEN FROM THE PAGE'S REQUEST. `request.reviewMedia` comes from
 * `blocks.getPublishRequest`, which is fetched once and deliberately never invalidated (the page
 * memoises on its identity). So after a re-rate the badges and reveals read the level from
 * `appListings.getAssets` — the same read the approve bar's rating warning uses, and the one
 * `ReviewImageRatingPicker` updates after a re-rate — and the screenshots from
 * `appListings.getListingPreviewForReview`. Until those answer, the request's own levels show.
 *
 * Without a listing, or for a viewer who is not a moderator, this is plain `ReviewListingMedia`:
 * no reads, no pickers.
 */
export function ReviewListingMediaLive({ listingId, approveListingId, ...props }: LiveProps) {
  const currentUser = useCurrentUser();
  // A separate component below, so the plain case makes no reads at all.
  if (!listingId || !currentUser?.isModerator) return <ReviewListingMedia {...props} />;
  const listingIds = [
    listingId,
    ...(approveListingId && approveListingId !== listingId ? [approveListingId] : []),
  ];
  return <RerateableListingMedia {...props} listingId={listingId} listingIds={listingIds} />;
}

function RerateableListingMedia({
  listingId,
  listingIds,
  reviewMedia,
  ...props
}: Omit<LiveProps, 'listingId' | 'approveListingId'> & {
  listingId: string;
  listingIds: readonly string[];
}) {
  const assets = trpc.appListings.getAssets.useQuery({ listingId }, { retry: false });
  const preview = trpc.appListings.getListingPreviewForReview.useQuery(
    { listingId },
    { retry: false }
  );
  const levels = liveLevelsById(assets.data);
  const media: ListingReviewMedia | null = reviewMedia
    ? {
        icon: withLiveLevel(reviewMedia.icon, levels),
        cover: withLiveLevel(reviewMedia.cover, levels),
        redIcon: withLiveLevel(reviewMedia.redIcon, levels),
        redCover: withLiveLevel(reviewMedia.redCover, levels),
      }
    : null;
  const screenshots = (preview.data?.media.screenshots ?? []).map(
    (shot) => withLiveLevel(shot, levels) ?? shot
  );
  return (
    <ReviewListingMedia
      {...props}
      reviewMedia={media}
      screenshots={screenshots}
      rerateListingIds={listingIds}
    />
  );
}
