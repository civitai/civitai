/**
 * The store-listing PUBLISH FLOOR: a listing must have an icon AND a cover before it can go
 * live. Screenshots, description, tagline and category are recommended, never required.
 *
 * 🔴 ONE PREDICATE. The callers that check the floor all ask {@link checkListingMeetsFloor}:
 * the off-site submit / approve / apply gates and the owner-republish review pre-check
 * (through `assertListingMeetsFloor` in `app-listing-assets.service`, which re-exports this),
 * the on-site version approve (`approveRequest`, up front and again in the draft
 * transition's `where`), the moderator queue's "Approve is disabled" fact
 * (`listingFactsForRequests`), and the readiness a submit answers with (`submitVersion`).
 *
 * ⚠️ NOT EVERY GO-LIVE CHECKS IT. A moderator `relistListing` (removed → approved) and an
 * owner `republishOwnListing` that restores immediately (no review) re-publish a listing's
 * existing assets without this check, and the legacy approve-time create (a first version
 * with no draft) mints an art-less listing. Those paths restore or mint what was there; they
 * are not gated by this predicate today.
 *
 * It lives in `shared/` — PURE, no server imports — so the review UI can word the same
 * missing set the server refused on.
 */

/** The assets a listing MUST have before it can be published. */
export const FLOOR_ASSETS = ['icon', 'cover'] as const;

export type FloorAsset = (typeof FLOOR_ASSETS)[number];

export type ListingFloorResult = { ok: true } | { ok: false; missing: FloorAsset[] };

/** The two columns the floor reads. `undefined` counts as missing (fails closed). */
export type ListingFloorInput = {
  iconId: number | null | undefined;
  coverId: number | null | undefined;
};

/**
 * Pure floor check: a listing meets the publish floor when it has an icon AND a cover.
 * Returns the missing floor assets (icon before cover); never throws.
 */
export function checkListingMeetsFloor(listing: ListingFloorInput): ListingFloorResult {
  const missing: FloorAsset[] = [];
  if (listing.iconId == null) missing.push('icon');
  if (listing.coverId == null) missing.push('cover');
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** "an icon and a cover" / "an icon" / "a cover", for the assets in `missing`. */
export function floorAssetsPhrase(missing: readonly FloorAsset[]): string {
  const icon = missing.includes('icon');
  const cover = missing.includes('cover');
  if (icon && cover) return 'an icon and a cover';
  if (icon) return 'an icon';
  if (cover) return 'a cover';
  return '';
}

/**
 * What the DEVELOPER is told at submit when the listing this submission publishes is below
 * the floor: the submit stands (they can add art while it waits), but a moderator cannot
 * approve it until they do.
 */
export function listingFloorNextStep(missing: readonly FloorAsset[]): string {
  return `Add ${floorAssetsPhrase(
    missing
  )} on your listing's Media tab before a moderator can approve it.`;
}

/** What a MODERATOR is told when Approve is refused (and why the button is disabled). */
export function listingFloorApproveRefusal(missing: readonly FloorAsset[]): string {
  return `Cannot approve yet: the store listing this approve publishes has no ${missing.join(
    ' or '
  )}. Every listing needs an icon and a cover before it goes live — the developer adds them on the listing's Media tab, then you can approve.`;
}
