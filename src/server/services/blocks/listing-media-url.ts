import { getEdgeUrl } from '~/client-utils/edge-url';

/**
 * The ONE projection from an `AppListing`'s media FKs to CDN URLs.
 *
 * 🔴 IT IS A MODULE RATHER THAN TWO PRIVATE HELPERS BECAUSE THERE ARE NOW TWO READS.
 * `app_listings.icon_id` / `cover_id` are integer FKs to `Image`, not URLs, so every
 * surface that shows listing media has to do the same `Image.url` → `getEdgeUrl` hop with
 * the same widths. That was written once inside `app-listing.service` (the PUBLIC store
 * projection); the AUTHOR-facing `listMine` read needs it too, and a second copy would be
 * two places to change a width and two places to get the null handling wrong.
 *
 * Both widths are the store's, deliberately: an author looking at their own row must see
 * the same asset the store will render, at the same resolution class.
 */

/** Icon render width. Icons are square chips; 256 covers a 2× 128 px slot. */
export const LISTING_ICON_WIDTH = 256;
/** Cover render width. Covers are the wide card/hero image. */
export const LISTING_COVER_WIDTH = 1200;

/** Build a CDN icon URL from an icon `Image` row (or null/absent). */
export function listingIconUrl(icon: { url: string | null } | null | undefined): string | null {
  return icon?.url ? getEdgeUrl(icon.url, { width: LISTING_ICON_WIDTH }) : null;
}

/**
 * Cover URL = the cover `Image`, else `fallbackUrl`, else null.
 *
 * 🔴 `fallbackUrl` IS A PARAMETER RATHER THAN A BUILT-IN SCREENSHOT LOOKUP, and the two
 * callers pass different things ON PURPOSE:
 *
 *   - the PUBLIC store projection passes the first screenshot's URL, because a shopper
 *     should see *something* rather than a grey box;
 *   - the AUTHOR's own "My apps" read passes `null`, because a missing cover is exactly
 *     the fact its owner needs to see. Substituting a screenshot there would hide an
 *     incomplete listing from the only person who can complete it — and the advisory
 *     `computeListingProblems` warning already tells them the cover is missing, so the
 *     table and the warning would contradict each other.
 */
export function listingCoverUrl(
  cover: { url: string | null } | null | undefined,
  fallbackUrl: string | null
): string | null {
  if (cover?.url) return getEdgeUrl(cover.url, { width: LISTING_COVER_WIDTH });
  return fallbackUrl;
}
