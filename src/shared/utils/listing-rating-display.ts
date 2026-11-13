import type { ListingAssetsView } from '~/server/services/blocks/app-listing-assets.service';
import { isMatureContentRating } from '~/server/utils/server-domain';
import {
  contentRatingFromNsfwLevel,
  deriveContentRatingFromAssets,
  nsfwLevelFromContentRating,
  offsiteContentRatingLabel,
  type OffsiteRatingValue,
} from '~/shared/constants/browsingLevel.constants';

/** Where a mature-rated listing is and is not shown, as the copy names them. */
export const SFW_STORE_HOST = 'civitai.com';
export const MATURE_STORE_HOST = 'civitai.red';

/** `red-icon` / `red-cover` are the civitai.red-only overrides of the icon and cover. */
export type ListingRatingDisplayAssetKind =
  | 'icon'
  | 'cover'
  | 'screenshot'
  | 'red-icon'
  | 'red-cover';

export type ListingRatingDisplayAsset = {
  kind: ListingRatingDisplayAssetKind;
  /** 1-based position among the listing's screenshots; unset for the icon and cover. */
  position?: number;
  /** The image's detected level. `null`/`0` = not rated yet, which raises nothing. */
  nsfwLevel: number | null | undefined;
  /**
   * Set exactly for the `red-icon` / `red-cover` kinds: the marker `ratingFloorAssets` reads, so a
   * split never floors the rating by an image civitai.com never shows.
   */
  redSlot?: boolean;
};

export type ListingRatingState = {
  rating: string | null;
  /** `rating` sits above the declared one. */
  raised: boolean;
  /** Mature, so the listing is absent from the SFW store. */
  hiddenOnSfw: boolean;
};

export type ListingRatingSummary = {
  declared: string | null;
  /** The minimal rating covering the supplied assets; `null` only when `assets` was omitted. */
  derived: OffsiteRatingValue | null;
  /** The rating the listing row carries today. `rating` is `null` when it was not supplied. */
  current: ListingRatingState;
  /** What approving these assets under the declared rating stamps: the higher of the two. */
  projected: ListingRatingState;
  /** The assets at the derived level, when that level is above the declared rating. */
  drivingAssets: ListingRatingDisplayAsset[];
  /** The listing row does not carry the projected rating yet: a review still has to apply it. */
  projectedExceedsCurrent: boolean;
  /** The listing row is rated above the projection, so its images alone do not explain it. */
  currentExceedsProjected: boolean;
  /** Every supplied asset has a detected level, so "no image is rated that high" is sayable. */
  allAssetsRated: boolean;
};

function ratingState(rating: string | null, declared: string | null): ListingRatingState {
  return {
    rating,
    raised:
      rating != null && nsfwLevelFromContentRating(rating) > nsfwLevelFromContentRating(declared),
    hiddenOnSfw: isMatureContentRating(rating),
  };
}

/**
 * The one derivation of a listing's rating state: what it is rated, whether that is above
 * what the author declared, whether it is hidden from the SFW store, and which images
 * require the higher rating.
 *
 * Ratings are compared by the level they permit, so `g` and `pg` (both PG) never count
 * as a raise of one over the other — the same comparison the approve-time floor makes.
 */
export function summarizeListingRating(input: {
  declaredRating: string | null | undefined;
  listingRating?: string | null;
  assets?: ListingRatingDisplayAsset[];
}): ListingRatingSummary {
  const declared = input.declaredRating ?? null;
  const assets = input.assets ?? null;
  const derived = assets ? deriveContentRatingFromAssets(assets) : null;
  const assetsExceedDeclared =
    derived != null && nsfwLevelFromContentRating(derived) > nsfwLevelFromContentRating(declared);
  const current = ratingState(input.listingRating ?? null, declared);
  const projected = ratingState(assetsExceedDeclared ? derived : declared, declared);
  return {
    declared,
    derived,
    current,
    projected,
    projectedExceedsCurrent:
      nsfwLevelFromContentRating(projected.rating) > nsfwLevelFromContentRating(current.rating),
    currentExceedsProjected:
      nsfwLevelFromContentRating(current.rating) > nsfwLevelFromContentRating(projected.rating),
    allAssetsRated:
      assets != null && assets.length > 0 && assets.every((a) => assetRating(a.nsfwLevel) != null),
    drivingAssets:
      assets && assetsExceedDeclared
        ? assets.filter((a) => assetRating(a.nsfwLevel) === derived)
        : [],
  };
}

/** The listing rating one image requires, or `null` while it has no detected level. */
export function assetRating(nsfwLevel: number | null | undefined): OffsiteRatingValue | null {
  return nsfwLevel ? contentRatingFromNsfwLevel(nsfwLevel) : null;
}

export function listingRatingAssetLabel(asset: ListingRatingDisplayAsset): string {
  if (asset.kind === 'icon') return 'Icon';
  if (asset.kind === 'cover') return 'Cover';
  if (asset.kind === 'red-icon') return `${MATURE_STORE_HOST} icon`;
  if (asset.kind === 'red-cover') return `${MATURE_STORE_HOST} cover`;
  return asset.position != null ? `Screenshot ${asset.position}` : 'Screenshot';
}

/**
 * The rating an on-site listing's backing app declares, kept apart from the listing's own
 * stored rating; `null` for an off-site listing (even one with an app attached) or an
 * on-site one with no app row.
 *
 * This is the declaration a rating FLOOR may rest on: it never falls back to the stored
 * rating, which would make the stored value its own floor.
 */
export function appDeclaredListingRating(input: {
  kind: string;
  appRating: string | null | undefined;
}): string | null {
  return input.kind === 'onsite' ? input.appRating ?? null : null;
}

/**
 * The rating the author declared for a listing, or `null` when none survives to compare.
 *
 * An on-site app declares it in its manifest, kept on the app row
 * (`appDeclaredListingRating`); before the first approval there is no app row and the
 * listing still carries the submitted value. An off-site listing has no separate
 * declaration: approval overwrites the author's rating.
 */
export function declaredListingRating(input: {
  kind: string;
  appRating: string | null | undefined;
  listingRating: string | null | undefined;
}): string | null {
  if (input.kind !== 'onsite') return null;
  return appDeclaredListingRating(input) ?? input.listingRating ?? null;
}

/** The per-asset levels of one listing, as `appListings.getAssets` returns them. */
export type ListingAssetLevels = Pick<
  ListingAssetsView,
  'iconId' | 'coverId' | 'iconNsfwLevel' | 'coverNsfwLevel'
> &
  Partial<
    Pick<ListingAssetsView, 'redIconId' | 'redCoverId' | 'redIconNsfwLevel' | 'redCoverNsfwLevel'>
  > & { screenshots: Pick<ListingAssetsView['screenshots'][number], 'imageId' | 'nsfwLevel'>[] };

/**
 * Those levels as rating assets in display order (the civitai.red overrides last); a read that
 * has not arrived is empty.
 */
export function listingRatingAssetsFromView(
  view: Partial<ListingAssetLevels>
): ListingRatingDisplayAsset[] {
  return [
    ...(view.iconId != null ? [{ kind: 'icon' as const, nsfwLevel: view.iconNsfwLevel }] : []),
    ...(view.coverId != null ? [{ kind: 'cover' as const, nsfwLevel: view.coverNsfwLevel }] : []),
    ...(view.screenshots ?? [])
      .filter((s) => s.imageId != null)
      .map((s, i) => ({ kind: 'screenshot' as const, position: i + 1, nsfwLevel: s.nsfwLevel })),
    ...(view.redIconId != null
      ? [{ kind: 'red-icon' as const, nsfwLevel: view.redIconNsfwLevel, redSlot: true }]
      : []),
    ...(view.redCoverId != null
      ? [{ kind: 'red-cover' as const, nsfwLevel: view.redCoverNsfwLevel, redSlot: true }]
      : []),
  ];
}

/** "Cover (R) and Screenshot 2 (R)" — the driving assets, each with the rating it requires. */
export function describeRatingAssets(assets: ListingRatingDisplayAsset[]): string {
  const parts = assets.map((a) => {
    const rating = assetRating(a.nsfwLevel);
    const label = listingRatingAssetLabel(a);
    return rating ? `${label} (${offsiteContentRatingLabel(rating)})` : label;
  });
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
