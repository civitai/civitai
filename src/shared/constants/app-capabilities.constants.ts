import {
  APP_LISTING_STATUSES,
  type AppListingStatus,
} from '~/server/services/blocks/app-listing-status.constants';

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
   * What it cannot do is open the STANDALONE editor — but 🔴 THE HOST RESOLVER IS NO
   * LONGER WHY. `appListings.getMyListingForApp` was re-keyed by civitai/civitai#3984
   * and now takes `appBlockId` OR `slug`, resolving any top-level listing of either
   * kind, so it addresses an off-site listing fine. What still withholds the surface is
   * the WEB tab gate `editorTabsFor` (`src/components/Apps/appListingEditorTabs.ts`),
   * whose `media` arm requires `ctx.appBlockId != null` on top of this cell — and an
   * off-site listing has no block id to give it.
   *
   * So this cell is a statement about the SURFACE, not about the data model, and unlike
   * `earnings` / `submitVersion` it is NOT structural — it is plumbing, half of which
   * (the resolver) has now been re-keyed while the tab gate has not. Tracked by
   * https://github.com/civitai/civitai/issues/3893, whose fix is precisely "flip this
   * cell to true" (and drop the block-id clause from that `media` arm). Until then, a
   * table that claimed off-site media worked would be a permission table asserting more
   * than the UI offers, which is the exact defect class this feature keeps finding.
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
 *   - `listingMedia` — 🔴 NOT structural: PLUMBING. The data supports it, and since
 *     civitai/civitai#3984 so does the host resolver (`getMyListingForApp` takes
 *     `appBlockId` OR `slug`). What is left is the WEB tab gate: `editorTabsFor`'s
 *     `media` arm also demands `ctx.appBlockId != null`, which an off-site listing
 *     cannot supply. See its doc above and https://github.com/civitai/civitai/issues/3893.
 *     Flipping this cell is a real change with a real fix behind it, unlike the two
 *     above, which cannot be flipped without changing the schema.
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
    // Held false by the WEB tab gate (`editorTabsFor`'s `media` arm also needs a
    // non-null `appBlockId`), NOT by the host resolver — `getMyListingForApp` takes a
    // slug since civitai/civitai#3984. Plumbing, not schema — civitai/civitai#3893 is
    // the work that flips this.
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
 * the first thing it loads cannot disagree: that proc refuses `removed` with FORBIDDEN
 * ('removed by a moderator and can no longer be edited') and `rejected` with
 * MUST_RESUBMIT. Before this gate the authoring page opened happily on a moderator-REMOVED
 * listing — every tab rendered, and the Collaborators tab was fully live, so an owner
 * could still invite someone onto a delisted app and the acceptance would mint Forgejo
 * `write` on its repo. The procs were always going to refuse the CONTENT edits; it is this
 * PR that made the page reachable, so the gate belongs here.
 *
 * 🔴 IT NO LONGER MIRRORS THAT SWITCH EXACTLY, AND THE DIVERGENCE IS DELIBERATE.
 * `getMyListingForEdit`/`updateListing` now admit a `removed` listing whose LAST
 * moderation event is the owner's own `owner-unpublish` — an owner who took
 * their app down to repair it can now repair it. This set was NOT widened to match,
 * because `removed` is one status string covering two states and this constant cannot see
 * which: adding it would also open every CONTENT tab — above all Collaborators, where
 * accepting an invite mints repo `write` — on a MODERATOR-delisted listing. The status
 * column is the wrong instrument for that question; the procs branch on the last
 * moderation action instead. Widen this set only if it too gains that bit.
 */
export const AUTHORABLE_LISTING_STATUSES = ['draft', 'pending', 'approved'] as const;

/** Is this listing in a state its owner may still author? */
export function isAuthorableListingStatus(status: string): boolean {
  return (AUTHORABLE_LISTING_STATUSES as readonly string[]).includes(status);
}

/**
 * The listing statuses on which a PUBLISHING CONTROL exists at all.
 *
 * 🔴 A SEPARATE, NARROWER CONCEPT FROM {@link AUTHORABLE_LISTING_STATUSES}, and the two
 * deliberately overlap on exactly one value. `approved` is where Unpublish exists;
 * `removed` is where Republish exists — and `removed` is NOT authorable, which is the
 * whole reason this constant had to be minted rather than the authorable set widened.
 * Widening that set would re-admit `removed` to the CONTENT tabs, and above all to
 * Collaborators, where accepting an invite still mints Forgejo `write` on the repo of a
 * delisted app. See {@link LISTING_AUTHORING_ROUTE_STATUSES}.
 *
 * `draft`/`pending` are absent because an app that was never published has nothing to
 * take down, and `rejected` because it never reached the store either. On those the tab
 * would be an empty panel — the "never render a surface that can only refuse" rule the
 * tab derivation is built around.
 */
export const PUBLISHABLE_LISTING_STATUSES = ['approved', 'removed'] as const;

/** Does a publish/unpublish control exist for a listing in this state? */
export function isPublishableListingStatus(status: string): boolean {
  return (PUBLISHABLE_LISTING_STATUSES as readonly string[]).includes(status);
}

/**
 * The MATERIAL scalar fields of a listing patch — the ones whose value a MODERATOR
 * approved, so a change to any of them cannot go live without re-review.
 *
 * 🔴 IT LIVES HERE, IN `shared/`, FOR THE SAME STRUCTURAL REASON THE CAPABILITY TABLE
 * ABOVE DOES. The definition was a module-private literal in `offsite-listing.service.ts`,
 * which top-level-imports `~/server/db/client` — so the EDIT FORM could not read it without
 * dragging Prisma into the browser bundle, and therefore could not know which of its inputs
 * the server is going to refuse. It re-typed nothing and simply rendered every field as
 * editable; on an owner-unpublished listing that is four inputs an author can fill and can
 * never save (`MATERIAL_CHANGE_BLOCKED`). `offsite-listing.service.ts` now imports this,
 * so there is still exactly ONE definition and the form's disabled set cannot drift from
 * the server's refusal set.
 *
 * 🔴 ADDING A FIELD HERE IS A UI CHANGE AS WELL AS A SERVER ONE. `ExternalListingEditForm`
 * tags each material input with `data-material-field="<name>"` and
 * `ExternalSubmitForm.ownerUnpublished.browser.test.tsx` iterates THIS list asserting every
 * member has such an input and that it is disabled in the repair state — so a new material
 * field with no disabled input turns that ledger red rather than shipping an unsaveable box.
 *
 * NOT the whole material surface: a change to the DISCLOSED OAuth scope mask
 * (`requestedScopes`) is material too, but it is not an author-typed field — it is derived
 * from the connect client's current `allowedScopes` — so it has no input to disable and is
 * handled separately at both ends. See `materialPatchChanges`.
 */
export const MATERIAL_LISTING_PATCH_FIELDS = [
  'externalUrl',
  'name',
  'contentRating',
  'sourceRepoUrl',
] as const;

/**
 * One member of {@link MATERIAL_LISTING_PATCH_FIELDS}.
 *
 * 🔴 ITS JOB IS TO MAKE A NARROWED SWEEP FAIL WHEN THE SET GROWS. The ledger tests walk the
 * constant, but an arm that legitimately covers only SOME members (the on-site case, which
 * has no `externalUrl` input because it has no URL step) has to express that as
 * `Exclude<MaterialListingPatchField, 'externalUrl'>` rather than as a hand-written literal
 * list. A literal is a ledger that cannot grow: add a fifth material field and the sweep
 * still passes, having never mentioned it.
 */
export type MaterialListingPatchField = (typeof MATERIAL_LISTING_PATCH_FIELDS)[number];

/**
 * Every listing status the canonical authoring ROUTE may open on — in FULL authoring mode
 * or in the narrowed publishing/history mode.
 *
 * 🔴 THIS IS NOT AN AUTHORIZATION SET; it is the KNOWN-STATUS set, and its job is to FAIL
 * CLOSED. What a caller may actually reach on a given status is decided by `editorTabsFor`
 * (which withholds every content tab, and above all Collaborators, on a non-authorable
 * status) and by each proc's own gate. This list exists so a status this code has never
 * heard of — a new lifecycle value, a typo, a column read from somewhere unexpected —
 * refuses the page outright instead of falling into the narrowed branch by default.
 *
 * 🔴 DERIVED FROM `APP_LISTING_STATUSES`, NOT HAND-COPIED, and that changed after review.
 * It was five string literals restating the same value space, with nothing tying them to
 * the one constant that HAS a migration-agreement test against the `app_listings_status_check`
 * DB CHECK. The failure mode of a hand-copy here is quiet and total: add a sixth lifecycle
 * status and this list would not know about it, so `canOpenListingAuthoringPage` would
 * return `false` and the authoring page would FORBID that entire cohort — fail-closed, but a
 * complete outage for them, with no test going red. Deriving makes that drift impossible
 * rather than merely detectable.
 *
 * If a future status must be EXCLUDED from the route, replace the alias with an explicit
 * filter over `APP_LISTING_STATUSES` — never with a fresh literal list. The equality case in
 * `myAppsView.test.ts` is the tripwire for exactly that edit.
 *
 * 🔴 WHY THE ROUTE OPENS ON `removed` AT ALL. Both an owner Unpublish and a moderator
 * takedown write `status='removed'`. While this route refused that status, an owner who
 * unpublished their own app could not reach Republish from the canonical editor — a
 * one-way door only a moderator `relistListing` could reopen. That is the exact defect
 * civitai/civitai#4218 exists to prevent, so the fix is to open the route and withhold the
 * tabs, never to widen {@link AUTHORABLE_LISTING_STATUSES}.
 */
export const LISTING_AUTHORING_ROUTE_STATUSES: readonly AppListingStatus[] = APP_LISTING_STATUSES;

/**
 * May the authoring route open on this status at all (full OR narrowed)?
 *
 * 🔴 UNKNOWN ⇒ `false`. See {@link LISTING_AUTHORING_ROUTE_STATUSES}.
 */
export function canOpenListingAuthoringPage(status: string): boolean {
  return (LISTING_AUTHORING_ROUTE_STATUSES as readonly string[]).includes(status);
}
