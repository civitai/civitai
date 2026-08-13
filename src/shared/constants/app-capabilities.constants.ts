/**
 * App Listing CAPABILITIES — what a listing of a given KIND can support at all.
 *
 * 🔴 THIS TABLE IS THE SINGLE SOURCE, AND IT LIVES IN `shared/` FOR A STRUCTURAL REASON,
 * not for tidiness. It used to live in `app-access.service.ts`, which top-level-imports
 * `~/server/db/client` — so any CLIENT component that wanted to derive "will this action
 * 403?" had the choice of dragging a Prisma client into the browser bundle (which
 * `no-server-infra-in-app-graph.test.ts` exists to prevent, and which stays GREEN when it
 * happens because `serverExternalPackages` externalises the leaf) or re-typing the table.
 * A second copy of a permission table is the exact shape that drifts and starts rendering
 * actions the server refuses.
 *
 * `app-access.service.ts` RE-EXPORTS everything here, so every pre-existing import site is
 * untouched and there is still exactly one definition.
 */

/** The store's two listing kinds. Mirrors `AppListing.kind`'s DB CHECK. */
export type ListingKind = 'onsite' | 'offsite';

/** The two capability roles. `null` (no access) is modelled as the absence of one. */
export type AppRole = 'owner' | 'editor';

export type ListingCapability =
  /** Listing content + media (name/tagline/description/icon/cover/screenshots). */
  | 'listingContent'
  /** Submit the listing for moderator review (`AppListingPublishRequest` + changelog). */
  | 'submitForReview'
  /** Listing analytics (`AppListingMetric` connect/visit, app views). */
  | 'analytics'
  /** Buzz earnings + payout figures. */
  | 'earnings'
  /** Ship a new app VERSION: the bundle submit path and Forgejo repo write. */
  | 'submitVersion';

/**
 * 🔴 THE CAPABILITY TABLE, and the two `false` cells are STRUCTURAL, not policy:
 *
 *   - `earnings` — `BlockBuzzAttribution` is keyed on `appBlockId` + a snapshotted
 *     `appOwnerUserId`. An off-site listing has no AppBlock, so there is no row that
 *     could ever be attributed to it. Returning a zeroed summary would be a lie
 *     indistinguishable from "earned nothing"; the read refuses instead.
 *   - `submitVersion` — an off-site listing has no bundle and no Forgejo repo. There
 *     is nothing to push to and no credential to mint.
 *
 * Everything else is identical across kinds, because an off-site listing carries the
 * same content, the same review flow (`AppListingPublishRequest`) and the same metric
 * rows as an on-site one.
 */
export const CAPABILITIES_BY_KIND: Readonly<
  Record<ListingKind, Readonly<Record<ListingCapability, boolean>>>
> = Object.freeze({
  onsite: Object.freeze({
    listingContent: true,
    submitForReview: true,
    analytics: true,
    earnings: true,
    submitVersion: true,
  }),
  offsite: Object.freeze({
    listingContent: true,
    submitForReview: true,
    analytics: true,
    // Block-scoped money. No AppBlock ⇒ no attribution rows can exist.
    earnings: false,
    // No bundle, no repo.
    submitVersion: false,
  }),
});

/** The capability set a listing of this kind can support at all. */
export function capabilitiesForKind(
  kind: ListingKind
): Readonly<Record<ListingCapability, boolean>> {
  return CAPABILITIES_BY_KIND[kind] ?? CAPABILITIES_BY_KIND.offsite;
}

/**
 * Does a listing of this kind support `capability`?
 *
 * 🔴 An UNKNOWN kind falls back to the OFFSITE (narrower) row, not the onsite one —
 * fail-closed. A kind this code does not recognise must never be handed the two
 * block-only capabilities.
 */
export function listingKindSupports(kind: string, capability: ListingCapability): boolean {
  return capabilitiesForKind(kind as ListingKind)[capability] === true;
}
