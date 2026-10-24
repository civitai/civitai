import {
  isLevelWithinCeiling,
  listingMediaCeiling,
  SFW_LISTING_MEDIA_AUDIENCE,
} from '~/server/services/blocks/listing-media-audience';
import { isMatureContentRating } from '~/server/utils/server-domain';
import {
  deriveContentRatingFromAssets,
  sfwBrowsingLevelsFlag,
  type OffsiteRatingValue,
} from '~/shared/constants/browsingLevel.constants';
import type { ListingMediaSplitDecision } from '~/shared/constants/listing-media-split.constants';
import type { ListingRatingDisplayAsset } from '~/shared/utils/listing-rating-display';

export {
  LISTING_MEDIA_SPLIT_DECISIONS,
  type ListingMediaSplitDecision,
} from '~/shared/constants/listing-media-split.constants';

/**
 * A listing's "media split": a moderator's recorded decision that a SFW app keeps its SFW media
 * on civitai.com and shows its mature media on civitai.red only. With the split, the listing's
 * `content_rating` is floored by its civitai.com-eligible media alone; without it, by all of its
 * media (the default, and the only behaviour before the split existed).
 *
 * Pure (no database, no server infrastructure), so the approve-time floors, the image re-rate
 * re-derive and the moderator review UI all decide "which assets floor the rating" here.
 */

/**
 * Whether an image at `nsfwLevel` still floors a split listing: whenever civitai.com could show it
 * (the gate's own level comparison against SFW). An image the store might show there is never left
 * out of the floor; one that also carries a mature bit then derives a mature rating, as it should.
 */
export function isComEligibleLevel(nsfwLevel: number | null | undefined): boolean {
  return isLevelWithinCeiling(nsfwLevel ?? 0, sfwBrowsingLevelsFlag);
}

/**
 * The assets that floor a listing's `content_rating`: all of them, or with a split only the
 * civitai.com-eligible ones.
 *
 * `redSlot` marks a civitai.red icon / cover override. civitai.com never shows one, so with a
 * split it never floors the rating, whatever its level. Without a split it floors it like any
 * other image: setting a mature civitai.red icon on an unsplit listing rates the listing by it,
 * until a moderator records the split.
 */
export function ratingFloorAssets<T extends { nsfwLevel?: number | null; redSlot?: boolean }>(
  assets: readonly T[],
  mediaSplit: boolean
): T[] {
  return mediaSplit
    ? assets.filter((a) => a.redSlot !== true && isComEligibleLevel(a.nsfwLevel))
    : [...assets];
}

/** Where one listing image can be seen, for the author and moderator labels. */
export type ListingAssetAudience = 'com-and-red' | 'red-only' | 'unrated';

/**
 * The audience of one SFW-slot image under a listing rating, by level alone and by the gate's own
 * level comparison: a flagged or blocked image is hidden everywhere, which the scan badges report
 * separately. A mature-rated listing is not on civitai.com at all, so every rated image of one is
 * `red-only`.
 */
export function listingAssetAudience(
  nsfwLevel: number | null | undefined,
  contentRating: string | null | undefined
): ListingAssetAudience {
  if (!nsfwLevel) return 'unrated';
  if (isMatureContentRating(contentRating ?? null)) return 'red-only';
  const comCeiling = listingMediaCeiling(SFW_LISTING_MEDIA_AUDIENCE, contentRating);
  return isLevelWithinCeiling(nsfwLevel, comCeiling) ? 'com-and-red' : 'red-only';
}

/**
 * {@link listingAssetAudience} for a display asset: a civitai.red icon / cover override shows only
 * on civitai.red whatever its level and the listing's rating (or nowhere, before it is rated).
 */
export function listingDisplayAssetAudience(
  asset: Pick<ListingRatingDisplayAsset, 'nsfwLevel' | 'redSlot'>,
  contentRating: string | null | undefined
): ListingAssetAudience {
  if (asset.redSlot === true) return asset.nsfwLevel ? 'red-only' : 'unrated';
  return listingAssetAudience(asset.nsfwLevel, contentRating);
}

export const LISTING_ASSET_AUDIENCE_LABEL: Record<ListingAssetAudience, string> = {
  'com-and-red': 'civitai.com + civitai.red',
  'red-only': 'civitai.red only',
  unrated: 'not rated yet — hidden',
};

export type ListingMediaSplitSummary = {
  /** The rating covering every image: what an approve without a split floors at. */
  allMediaRating: OffsiteRatingValue;
  /** The rating covering only the civitai.com-eligible images: what a split floors at. */
  comMediaRating: OffsiteRatingValue;
  /**
   * Some image is above SFW, or the listing has a civitai.red icon / cover override, so a split
   * would change what the rating is floored by.
   */
  splitChangesFloor: boolean;
  /** The icon and cover are civitai.com-eligible, which the server requires to grant a split. */
  faceEligible: boolean;
};

/** What a moderator's split decision would change for these images. */
export function summarizeListingMediaSplit(
  assets: readonly ListingRatingDisplayAsset[]
): ListingMediaSplitSummary {
  return {
    allMediaRating: deriveContentRatingFromAssets(ratingFloorAssets(assets, false)),
    comMediaRating: deriveContentRatingFromAssets(ratingFloorAssets(assets, true)),
    splitChangesFloor: assets.some((a) => a.redSlot === true || !isComEligibleLevel(a.nsfwLevel)),
    faceEligible: assets
      .filter((a) => a.kind === 'icon' || a.kind === 'cover')
      .every((a) => isComEligibleLevel(a.nsfwLevel)),
  };
}

/**
 * What a moderator's approve sends, and whether the choice is shown at all. The choice is shown
 * when it would change the floor or the listing is already split. Without an explicit choice it
 * keeps the listing's current state where that is still grantable (so approving an unrelated
 * revision does not silently end a moderator's split); a listing never split stays default-closed.
 * A choice that is not shown is never sent as a split.
 */
export function resolveListingMediaSplitDecision(args: {
  assets: readonly ListingRatingDisplayAsset[];
  currentlySplit: boolean;
  choice: ListingMediaSplitDecision | null;
}): { shown: boolean; value: ListingMediaSplitDecision } {
  const summary = summarizeListingMediaSplit(args.assets);
  const shown = summary.splitChangesFloor || args.currentlySplit;
  if (!shown) return { shown, value: 'rate-mature' };
  if (args.choice === 'split' && !summary.faceEligible) return { shown, value: 'rate-mature' };
  if (args.choice) return { shown, value: args.choice };
  return {
    shown,
    value: args.currentlySplit && summary.faceEligible ? 'split' : 'rate-mature',
  };
}
