import { NsfwLevel } from '~/server/common/enums';
import { isMatureContentRating } from '~/server/utils/server-domain';
import { onlySelectableLevels } from '~/shared/constants/browsingLevel.constants';
import {
  listingVisibleInStore,
  type AppListingVisibility,
  type ListingAudienceFloor,
} from '~/shared/utils/app-listing-visibility';
import { narrowStoreScope, type StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

/**
 * The app-layer half of "may this request open this listing's public store page", as a
 * pure predicate over one already-loaded row.
 *
 * It was the body of `loadStoreVisibleListingRow` in `app-listing.service.ts` and moved
 * here unchanged so a second reader — the viewer's "My apps" home, which resolves many
 * listings at once — applies the SAME gate instead of a re-derived copy. The detail,
 * card, social-image and fork-parent reads still reach it through that loader.
 *
 * Every term fails closed, in this order:
 *   1. an absent or unrecognised scope (`narrowStoreScope` → `none`) admits nothing;
 *   2. a shadow revision (`revisionOfId` set) is never a store listing;
 *   3. the per-listing level gate (`listingVisibleInStore`): status allowlist, then the
 *      level, then the viewer's audience floor — this is what drops `removed`
 *      (delisted / unpublished), `rejected` and unreviewed rows;
 *   4. `public-external` admits off-site listings only;
 *   5. an on-site listing whose block never deployed has no origin to serve;
 *   6. a mature (r/x) listing is hidden off a red-capable host, and on one it is shown only to
 *      a viewer whose browsing level includes that rating ({@link matureRatingsAllowed}).
 *
 * Pure and DB-free so it can be unit-tested without a client.
 */
export type StoreGateRow = {
  status: string;
  kind: string;
  contentRating: string | null;
  /** `undefined` is treated as "not a revision" — the loader's `where` already pins it. */
  revisionOfId?: string | null;
  appBlock: { currentVersionDeployedAt: Date | null } | null;
};

export function storeVisibleListingRowGate(args: {
  row: StoreGateRow;
  visibility: AppListingVisibility | null;
  scope: StoreVisibilityScope | undefined;
  floor: ListingAudienceFloor;
  redCapable: boolean;
  /**
   * The viewer's browsing level, for r/x listings only. Missing (`null`/`undefined`) reads as
   * PG, so no r/x. A caller that is not a public surface (the viewer's own My apps) passes
   * `allBrowsingLevelsFlag` to keep only the host gate.
   */
  browsingLevel: number | null | undefined;
}): boolean {
  const { row, visibility, floor, redCapable } = args;
  const scope = narrowStoreScope(args.scope);
  if (scope === 'none') return false;
  if (row.revisionOfId != null) return false;
  if (!listingVisibleInStore({ status: row.status, visibility, floor })) return false;
  if (scope === 'public-external' && row.kind !== 'offsite') return false;
  if (row.kind === 'onsite' && row.appBlock?.currentVersionDeployedAt == null) return false;
  if (
    !matureRatingAllowed(row.contentRating, matureRatingsAllowed(redCapable, args.browsingLevel))
  ) {
    return false;
  }
  return true;
}

/**
 * Which mature ratings a request may be shown: none off a red-capable host; on one, `r` when the
 * viewer's browsing level includes R and `x` when it includes X. G / PG / PG-13 are not part of
 * this — they are never hidden by the level (their images are filtered per viewer instead).
 *
 * These two booleans are ALL the store catalog cache keys on for the level, so viewers whose
 * levels differ only in PG / PG-13 / XXX / Blocked share one entry.
 */
export type MatureRatingsAllowed = { r: boolean; x: boolean };

export function matureRatingsAllowed(
  redCapable: boolean,
  browsingLevel: number | null | undefined
): MatureRatingsAllowed {
  if (!redCapable) return { r: false, x: false };
  const level = onlySelectableLevels(browsingLevel ?? 0);
  return { r: (level & NsfwLevel.R) !== 0, x: (level & NsfwLevel.X) !== 0 };
}

/** True unless `rating` is r/x and that rating is not allowed. The SQL twin is `listingMatureFilter`. */
export function matureRatingAllowed(
  rating: string | null | undefined,
  allowed: MatureRatingsAllowed
): boolean {
  if (!isMatureContentRating(rating)) return true;
  return (rating as string).toLowerCase() === 'r' ? allowed.r : allowed.x;
}

/** A mature rating the viewer's browsing level can hide. */
export type HiddenMatureRating = 'r' | 'x';

/**
 * On a mature-capable site, the r/x rating the viewer's browsing level hides for an app rated
 * `rating`, or null when nothing is hidden (a non-mature rating, or one the level includes).
 * {@link matureRatingAllowed} with the site gate already passed — for the surfaces that show a
 * hidden state (the run page, the detail page) rather than dropping the app. Call it only AFTER
 * the site gate; off a mature-capable site a mature app is not there at all.
 */
export function ratingHiddenByBrowsingLevel(
  rating: string | null | undefined,
  browsingLevel: number | null | undefined
): HiddenMatureRating | null {
  if (matureRatingAllowed(rating, matureRatingsAllowed(true, browsingLevel))) return null;
  return (rating as string).toLowerCase() === 'r' ? 'r' : 'x';
}
