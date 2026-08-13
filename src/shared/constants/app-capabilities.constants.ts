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
  /**
   * Listing SCALARS — name / tagline / description / category / external URL. Edited
   * through the LISTING-keyed, seat-aware `getMyListingForEdit` + `updateListing`, which
   * work identically for both kinds.
   */
  | 'listingContent'
  /**
   * The standalone listing-MEDIA editor surface (icon / cover / screenshots).
   *
   * 🔴 SPLIT OUT OF `listingContent`, and the split is the honest half of a distinction
   * the table used to paper over. An off-site listing CAN hold and edit assets — the
   * submit/edit wizard does exactly that, and the asset procs themselves
   * (`setIcon`/`setCover`/`addScreenshot`/…) are already listing-keyed and seat-aware.
   * What it cannot do is open the STANDALONE editor, because that surface is hosted by
   * `appListings.getMyListingForApp`, whose input is an `appBlockId` — and an off-site
   * listing has no AppBlock to name.
   *
   * So this cell is a statement about the SURFACE, not about the data model, and unlike
   * `earnings` / `submitVersion` it is NOT structural — it is plumbing that has not been
   * re-keyed yet. Tracked by https://github.com/civitai/civitai/issues/3893, whose fix is
   * precisely "flip this cell to true". Until then, a table that claimed off-site media
   * worked would be a permission table asserting more than holds, which is the exact
   * defect class this feature keeps finding.
   */
  | 'listingMedia'
  /** Submit the listing for moderator review (`AppListingPublishRequest` + changelog). */
  | 'submitForReview'
  /** Listing analytics (`AppListingMetric` connect/visit, app views). */
  | 'analytics'
  /** Buzz earnings + payout figures. */
  | 'earnings'
  /** Ship a new app VERSION: the bundle submit path and Forgejo repo write. */
  | 'submitVersion';

/**
 * 🔴 THE CAPABILITY TABLE. Three `false` cells for off-site, and they are NOT all the
 * same kind of claim — read the distinction before changing one:
 *
 *   - `earnings` — STRUCTURAL. `BlockBuzzAttribution` is keyed on `appBlockId` + a
 *     snapshotted `appOwnerUserId`. An off-site listing has no AppBlock, so there is no
 *     row that could ever be attributed to it. Returning a zeroed summary would be a lie
 *     indistinguishable from "earned nothing"; the read refuses instead.
 *   - `submitVersion` — STRUCTURAL. An off-site listing has no bundle and no Forgejo
 *     repo. There is nothing to push to and no credential to mint.
 *   - `listingMedia` — 🔴 NOT structural: PLUMBING. The data supports it; the surface's
 *     host resolver (`getMyListingForApp`) is block-keyed and has not been re-keyed yet.
 *     See its doc above and https://github.com/civitai/civitai/issues/3893. Flipping this
 *     cell is a real change with a real fix behind it, unlike the two above, which cannot
 *     be flipped without changing the schema.
 *
 * Everything else is identical across kinds, because an off-site listing carries the
 * same scalars, the same review flow (`AppListingPublishRequest`) and the same metric
 * rows as an on-site one.
 */
export const CAPABILITIES_BY_KIND: Readonly<
  Record<ListingKind, Readonly<Record<ListingCapability, boolean>>>
> = Object.freeze({
  onsite: Object.freeze({
    listingContent: true,
    listingMedia: true,
    submitForReview: true,
    analytics: true,
    earnings: true,
    submitVersion: true,
  }),
  offsite: Object.freeze({
    listingContent: true,
    // The standalone media editor is hosted by the BLOCK-keyed `getMyListingForApp`.
    // Plumbing, not schema — civitai/civitai#3893 is the work that flips this.
    listingMedia: false,
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

/**
 * The listing statuses the CANONICAL AUTHORING PAGE may be opened on.
 *
 * 🔴 MIRRORS `getMyListingForEdit`'s existing switch, deliberately, so the entry point and
 * the first thing it loads cannot disagree: that proc already refuses `removed` with
 * FORBIDDEN ('removed by a moderator and can no longer be edited') and `rejected` with
 * MUST_RESUBMIT. Before this gate the authoring page opened happily on a moderator-REMOVED
 * listing — every tab rendered, and the Collaborators tab was fully live, so an owner
 * could still invite someone onto a delisted app and the acceptance would mint Forgejo
 * `write` on its repo. The procs were always going to refuse the CONTENT edits; it is this
 * PR that made the page reachable, so the gate belongs here.
 */
export const AUTHORABLE_LISTING_STATUSES = ['draft', 'pending', 'approved'] as const;

/** Is this listing in a state its owner may still author? */
export function isAuthorableListingStatus(status: string): boolean {
  return (AUTHORABLE_LISTING_STATUSES as readonly string[]).includes(status);
}
