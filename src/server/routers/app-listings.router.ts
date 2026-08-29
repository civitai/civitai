import { TRPCError } from '@trpc/server';

import {
  addListingScreenshotSchema,
  appListingAuthoringContextSchema,
  assetScanStatusesSchema,
  backfillListingAssetsSchema,
  listingAssetsQuerySchema,
  removeListingScreenshotSchema,
  reorderListingScreenshotsSchema,
  setListingCoverSchema,
  setListingIconSchema,
  updateListingScreenshotCaptionSchema,
} from '~/server/schema/blocks/app-listing.schema';
import {
  getAppListingDetailSchema,
  listAllListingsForModerationSchema,
  listAppListingsSchema,
} from '~/server/schema/blocks/app-listing-read.schema';
import {
  getMyAppListingReviewSchema,
  listAppListingReviewsSchema,
  setAppListingReviewExcludeSchema,
  upsertAppListingReviewSchema,
} from '~/server/schema/blocks/app-listing-review.schema';
import {
  approveExternalRequestSchema,
  beginListingRevisionSchema,
  getMyListingForAppSchema,
  getMyListingForEditSchema,
  listMySubmissionsSchema,
  listOffsiteRequestsSchema,
  persistListingAssetImageSchema,
  rejectExternalRequestSchema,
  submitExternalListingSchema,
  submitListingRevisionSchema,
  updateListingSchema,
  updateRevisionDraftSchema,
  withdrawExternalRequestSchema,
} from '~/server/schema/blocks/offsite-listing.schema';
import {
  fetchListingMetaSchema,
  ingestListingAssetFromDataUriSchema,
  ingestListingAssetFromUrlSchema,
} from '~/server/schema/blocks/listing-meta.schema';
import {
  claimListingSchema,
  delistListingSchema,
  dismissReportSchema,
  listListingReportsSchema,
  listModerationEventsSchema,
  listMyListingModerationEventsSchema,
  purgeListingSchema,
  relistListingSchema,
  reportListingSchema,
  republishOwnListingSchema,
  resetListingToPendingSchema,
  resolveReportSchema,
  unpublishOwnListingSchema,
} from '~/server/schema/blocks/offsite-moderation.schema';
import { messageAppOwnerSchema } from '~/server/schema/blocks/app-moderator-message.schema';
import { rateLimit } from '~/server/middleware.trpc';
import {
  recordStoreScopeApplied,
  type StoreScopeEntrypoint,
} from '~/server/prom/store-scope.metrics';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { narrowStoreScope } from '~/shared/utils/store-visibility-scope';
import {
  isAppBlocksAuthorEnabled,
  isAppBlocksEnabled,
  resolveStoreVisibilityScope,
  type StoreVisibilityScope,
} from '~/server/services/app-blocks-flag';
import {
  appDeveloperProcedure,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import { isHostForColor } from '~/server/utils/server-domain';

/**
 * App Store Listings (W13) — asset pipeline + off-site submission router (NEW
 * router, locked decision §5.1 — NOT an extension of `blocks.router`). All procs
 * are DARK and additive: owner-scoped (mod override) creator asset management, a
 * mod-only placeholder backfill, the P2a unified store read path, and (P3a) the
 * off-site submission flow. No UI in P3a.
 *
 * Flag gates (three tiers):
 *   - `enforceAppBlocksAuthorFlag` (`app-blocks-author`) — the AUTHOR gate on the
 *     creator asset-CRUD procs + the off-site submit/withdraw/my-submissions
 *     procs (mods + app-dev-testers). Widened from mod-only in P3a so a dev-tester
 *     can manage their OWN listing's assets + submit off-site apps; the
 *     service-layer owner check still bounds every mutation to the caller.
 *   - `moderatorProcedure` (+ `enforceAppBlocksFlag` on backfill) — the mod-only
 *     backfill + the read-only off-site review-queue lists.
 *   - `enforceAppListingsReadFlag` (`app-listings`, OR-falling-back to
 *     `app-blocks-enabled`) — the DARK public store read path (empty page /
 *     NOT_FOUND until the segment widens at cutover).
 */
const enforceAppBlocksFlag = middleware(async ({ ctx, next }) => {
  if (await isAppBlocksEnabled({ user: ctx.user })) return next();
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
});

/**
 * AUTHOR flag gate (P3a) — the WIDENED gate for the creator asset-CRUD procs +
 * the off-site submit/withdraw/my-submissions procs. Evaluated WITH the caller's
 * context against `app-blocks-author` (`isAppBlocksAuthorEnabled`: mod floor +
 * the `app-dev-testers` cohort segment), so an app-dev-tester may manage their
 * OWN listing's assets + submit off-site apps — while the SERVICE-layer owner
 * check still bounds every mutation to the caller's own listings. This REPLACES
 * the mod-only `enforceAppBlocksFlag` (`isAppBlocksEnabled`) on those procs;
 * mods still pass via the author floor. Fail-CLOSED: absent flag / Flipt-down →
 * mods only. (The mod-only `backfillAssets` proc keeps `enforceAppBlocksFlag`.)
 */
const enforceAppBlocksAuthorFlag = middleware(async ({ ctx, next }) => {
  if (await isAppBlocksAuthorEnabled({ user: ctx.user })) return next();
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps authoring is not enabled' });
});

/**
 * Token-scope gate for the OWNER-SCOPED listing procs the civitai CLI drives
 * (`civitai app listing set-icon/set-cover/add-screenshot/rm-screenshot/reorder/status`,
 * civitai/cli#186; and `civitai app doctor` — the listing-problems read + its fixes).
 *
 * 🔴 THE SET IS NO LONGER "MEDIA" — the name is kept because it is referenced from the
 * CLI-side docs, but the membership rule is broader and is stated here so a future
 * annotation is a decision rather than a copy: a proc may carry this meta iff it is
 * OWNER-OR-SEAT bound independently of token scope, writes only author-owned state, and
 * (for an approved listing) routes material change through the shadow-revision model.
 * `listMine` + `getAssets` (the doctor READS) and `updateListing` +
 * `updateRevisionDraft` (its FIXES) joined on exactly that test; each states its own
 * verdict at its own site.
 *
 * The CLI acts as the caller over the SCOPED OAuth access token `civitai login` mints
 * (`UserRead | AppBlocksSubmit | AppBlocksDevTunnel`) — NOT a Full personal API key.
 * `enforceTokenScope` (`server/services/oauth/enforce-token-scope.ts`) treats an
 * UN-annotated proc as implicitly requiring `TokenScope.Full`; the CLI token is not
 * Full and lacks bits 0..24, so every un-annotated proc here 403s it today (the same
 * trap `startDevTunnel` faced). Annotating with `AppBlocksSubmit` (bit 25 — a bit the
 * CLI token already carries) makes them reachable by that token.
 *
 * 🔴 No regression to the Full-personal-key path: `enforceTokenScope` EARLY-RETURNS the
 * scope check for `ctx.tokenScope === TokenScope.Full`, so a Full personal API key (and
 * cookie session) STILL passes regardless of this meta — `Flags.hasFlag(Full,
 * AppBlocksSubmit)` (which is false, since `Full` deliberately excludes bit 25) is never
 * evaluated for a Full credential. So this meta only ADMITS the scoped CLI token; it
 * never gates a credential that works today.
 *
 * ADDITIVE, never loosening: each proc keeps its `appDeveloperProcedure` /
 * `protectedProcedure + enforceAppBlocksAuthorFlag` author-cohort gate and the
 * service-layer owner checks (`assertOwnerAssetEditable`, owner-bound `userId`). This is
 * one more gate the token must clear, applied only to owner-scoped procs — no MOD-ONLY
 * proc is annotated. Mirrors `blocks.router` `startDevTunnel`/`stopDevTunnel`
 * (`AppBlocksDevTunnel`).
 *
 * 🔴 THAT CLAIM NEEDS A QUALIFIER AND THE EARLIER WORDING ("no mod-only or CROSS-USER
 * proc is annotated") DID NOT CARRY IT: **the gate behind this set is NOT UNIFORM**, so
 * do not reason about one member from another. Derived by tracing every member (not by
 * pattern), the three shapes are:
 *
 *   1. MOD-BYPASSING, via `app-listing-assets::loadOwnedListing`, which short-circuits
 *      the ownership check for `user.isModerator` — disagreement D1 in
 *      `app-access.call-site-ledger.test.ts`, where sibling gates deliberately disagree
 *      about the bypass. Reached by `setIcon`, `setCover`, `addScreenshot`,
 *      `reorderScreenshots` (directly / via `resolveOwnerAssetEditTarget`) and by
 *      `updateScreenshotCaption`, `removeScreenshot` (via `resolveOwnerScreenshotTarget`).
 *      `getAssetScanStatuses` carries its OWN equivalent (`user.isModerator ? {} :
 *      { userId: user.id }`). Seven members.
 *   2. NO LISTING GATE AT ALL, caller-bound: `persistAssetImage`,
 *      `ingestAssetFromDataUri` create an `Image` owned by the caller and take no
 *      listing id. No bypass to have.
 *   3. NO MOD OVERRIDE, via `offsite-listing::loadOwnedEditableListing`:
 *      `getMyListingForEdit`, `getMyListingForApp`, `beginListingRevision`,
 *      `submitListingRevision`, `updateListing`, `updateRevisionDraft`.
 *
 * For a caller who IS a moderator, the shape-1 members are cross-listing, so this meta
 * lets a THIRD-PARTY APP the moderator authorised with `AppBlocksSubmit` inherit that
 * reach — where an un-annotated proc would have 403'd it. That is delegated moderator
 * authority rather than widened authority, and it is the accepted cost of admitting the
 * CLI on the media procs; it is written down rather than left to be discovered.
 *
 * 🔴 IT IS ALSO WHY `getAssets` IS **NOT** IN THIS SET. It was annotated during the
 * `civitai app doctor` work and the annotation was withdrawn as a product decision: it is
 * shape 1, and it is a pure READ whose whole payload was already reachable from procs
 * already in this set, so it carried the bypass and bought nothing. New annotations are
 * decided on that basis — what the proc ADDS, weighed against which gate it sits behind —
 * never by copying a sibling's `.meta(...)`.
 */
const listingMediaCliScope = { requiredScope: TokenScope.AppBlocksSubmit } as const;

/**
 * Flag gate for the P2a PUBLIC READ procs (unified store). Anon-CAPABLE but DARK
 * until launch: it resolves a STORE VISIBILITY SCOPE onto ctx (`_storeScope`) that
 * the 3 read procs branch on — `none` returns an EMPTY page / NOT_FOUND (never an
 * error, mirroring `blocks.router`'s read gate) rather than throwing.
 *
 * ## External-before-onsite GA (Phase 1) — the kind-aware scope
 *
 * `resolveStoreVisibilityScope(ctx.user)` returns:
 *   - `full`            — mods + app-dev-testers (`isAppListingsEnabled`, itself
 *     OR-falling-back to `isAppBlocksEnabled`): sees ALL kinds, byte-identical to
 *     today.
 *   - `public-external` — the NEW global `app-listings-public-external` flag is on:
 *     an anon/non-privileged viewer sees ONLY `kind='offsite'` listings (both
 *     sub-kinds). Onsite App Blocks stay hidden. Threaded into the data-layer kind
 *     predicate + the detail/reviews kind gate — the load-bearing boundary.
 *   - `none`            — neither flag → dark (today's public default).
 *
 * 🔴 DARK / INERT as-merged: `app-listings-public-external` does NOT exist in Flipt
 * yet, so a mod/tester still resolves `full` and everyone else `none` — ZERO change
 * until that flag is created + enabled in a later phase. The AUTHOR gate
 * (`enforceAppBlocksAuthorFlag`) + the mod-only backfill (`enforceAppBlocksFlag`)
 * stay on their existing flags — authoring is a separate axis from viewing.
 *
 * 🔴 The review WRITE gate (`enforceAppListingsWriteFlag`) USED to be listed here
 * too, on the reasoning that "the public-external axis is READ-only". That was the
 * defect: reviewing is a WRITE the read scope authorises, so leaving it on
 * `isAppListingsEnabled` locked the external-only cohort out of reviewing the very
 * listings this scope showed them. It now resolves the SAME scope and applies the
 * same kind rule — see that gate's own header.
 */
const enforceAppListingsReadFlag = middleware(async ({ ctx, next }) => {
  const _storeScope = await resolveStoreVisibilityScope({ user: ctx.user });
  return next({ ctx: { _storeScope } });
});

/**
 * Store WRITE gate for the review procs (`upsertReview` / `getMyReview` — the
 * COMPLETE set; `git grep enforceAppListingsWriteFlag` before adding a third).
 *
 * Mirrors `enforceAppBlocksFlag`'s HARD-THROW shape (a write with the store dark
 * must REJECT, not soft-fail like the read gate), but keyed on
 * `resolveStoreVisibilityScope` — the SAME resolver the read gate
 * (`enforceAppListingsReadFlag`) uses — and the resolved scope is threaded onto
 * ctx so each proc applies the shared KIND rule
 * ({@link scopeAdmitsListingKind}) exactly as the read path's data-layer
 * predicate does. `none` is the only scope this gate itself rejects.
 *
 * ## Why it is no longer keyed on a flag — the original reasoning, and how it failed
 *
 * This gate used to be `if (await isAppListingsEnabled({ user: ctx.user }))`, and
 * the comment justifying that read:
 *
 * > "This keeps the review WRITEs (`upsertReview`/`getMyReview`) on the SAME flag
 * > as the store visibility + reviews read path (`enforceAppListingsReadFlag`), so
 * > once `app-listings` widens independently of the held block-runtime gate, a
 * > viewer who can SEE the review affordance can also submit — instead of seeing
 * > the button and 403-ing on write."
 *
 * 🔴 The GOAL was right and is kept verbatim below; the MECHANISM was a bet that
 * the store would widen by widening `app-listings`, and it did not. It widened via
 * a THIRD flag plus a scope resolver: `app-listings-public-external` →
 * `resolveStoreVisibilityScope` → `public-external`. The read path moved onto the
 * scope; this gate stayed on the flag. `isAppListingsEnabled` is
 * `app-listings || app-blocks-enabled` and the external-only tester cohort holds
 * NEITHER, so its members reached an offsite listing's detail page, saw the review
 * button the read scope had legitimately shown them, and got
 * `UNAUTHORIZED: Apps are not enabled` on submit — the exact failure the comment
 * was written to prevent, arrived at by the route it did not anticipate.
 *
 * The lesson, and the reason the quotation is preserved rather than deleted:
 * "same flag as the read path" was a PROXY for "same admission rule as the read
 * path". The proxy held only while the read path was itself a flag check. Key the
 * write on whatever the read path actually branches on — today the scope.
 *
 * INVARIANT (kept): a viewer who can SEE the review affordance can submit, and a
 * viewer who cannot is not shown it. The client half is `useCanReviewListing`,
 * which applies the same `scopeAdmitsListingKind` rule.
 *
 * Zero change for the existing cohort: a mod / app-dev-tester resolves `full`
 * (axis 1 of the resolver IS `isAppListingsEnabled`), which admits every kind — so
 * their behaviour is byte-identical to the flag check this replaces.
 */
const enforceAppListingsWriteFlag = middleware(async ({ ctx, next }) => {
  const _storeScope = await resolveStoreVisibilityScope({ user: ctx.user });
  if (_storeScope === 'none') {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
  }
  return next({ ctx: { _storeScope } });
});

/**
 * Red-capable host check — maturity is a HOST property (independent of moderator
 * status), so even a mod on civitai.com does not see mature (r/x) listings in
 * these viewer-facing reads. Fail-closed: a missing host → false (SFW only).
 * Mirrors `blocks.router`'s `isRedCapableRequest`.
 */
function isRedCapableRequest(ctx: { req?: { headers?: { host?: string } } }): boolean {
  const host = ctx.req?.headers?.host ?? '';
  return host !== '' && isHostForColor(host, 'red');
}

/**
 * Read the visibility scope `enforceAppListingsReadFlag` put on ctx, RECORDING what
 * this entry point actually branched on.
 *
 * 🔴 The record happens BEFORE the `?? 'none'` fallback, and that ordering is the
 * point. The fallback is correct (an absent scope must fail CLOSED), but it also
 * erases the difference between "the resolver said `none`" and "no scope ever
 * reached this procedure" — two very different faults that produce the identical
 * `{ items: [] }`. civitai#3983 was stuck on exactly that ambiguity for the whole
 * investigation. `recordStoreScopeApplied` keeps them apart (`none` vs `absent`).
 */
function applyStoreScope(ctx: unknown, entrypoint: StoreScopeEntrypoint): StoreVisibilityScope {
  const raw = (ctx as { _storeScope?: unknown })._storeScope;
  recordStoreScopeApplied(raw as string | undefined, entrypoint);
  // 🔴 `raw ?? 'none'` already failed closed for a MISSING scope; `narrowStoreScope`
  // extends that to any value outside the closed set (a typo, a scope from a newer
  // branch this build cannot interpret), and — the point of consolidating it — makes
  // this branch and the two REST handlers apply the SAME rule instead of three
  // independently-written defaults that disagreed (civitai#3983).
  return narrowStoreScope(raw);
}

/**
 * Map a thrown off-site SERVICE error to the correct TRPC error for the mod client.
 *
 *   - A `TRPCError` the service already shaped (BAD_REQUEST: assets-incomplete /
 *     invalid stored URL / reason-length) passes THROUGH unchanged.
 *   - A typed `OffsiteRequestError` (P3a) OR `OffsiteModerationError` (P3b report/
 *     delist/claim) maps to its precise TRPC code (`NOT_FOUND`→NOT_FOUND,
 *     `NOT_OWNED`→FORBIDDEN, `ALREADY_REPORTED`→CONFLICT, `NOT_PENDING`/
 *     `NOT_REPORTABLE`/other→BAD_REQUEST). It is DUCK-TYPED on `name` + `code` so
 *     the router never has to eagerly `import` the service module (services are
 *     loaded via dynamic `import()` to keep the Prisma client out of the router's
 *     import graph).
 *   - Anything else is an UNEXPECTED infra/Prisma failure → INTERNAL_SERVER_ERROR
 *     with a GENERIC message; the raw error is preserved only on `cause` (for the
 *     central server-fault logger) and NEVER surfaced to the client.
 *
 * Replaces the previous blanket `BAD_REQUEST + (err as Error).message`, which both
 * mis-coded typed failures and leaked raw infra messages to moderators.
 */
function mapOffsiteError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (
    err instanceof Error &&
    (err.name === 'OffsiteRequestError' ||
      err.name === 'OffsiteModerationError' ||
      // Moderator → developer messaging. Duck-typed like its two siblings so the
      // service stays out of this router's STATIC import graph, and mapped HERE
      // rather than in a second mapper — a private `mapModMessageError` would be a
      // fourth spelling of the same code→TRPCError table, and the shapes that drift
      // between such copies are exactly the ones nobody re-reads (an unmapped code
      // silently becomes BAD_REQUEST).
      err.name === 'AppModeratorMessageError') &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    const code = (err as { code?: unknown }).code as string;
    const trpcCode =
      code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : code === 'NOT_OWNED' || code === 'FORBIDDEN'
        ? 'FORBIDDEN'
        : code === 'ALREADY_REPORTED'
        ? 'CONFLICT'
        : // 🔴 An exhausted quota must NOT fall through to the BAD_REQUEST default.
        // BAD_REQUEST reads to a caller as "your input was wrong" and carries no
        // retry semantics, so a mod who hit the hourly ceiling would be told to fix
        // a message that is fine. TOO_MANY_REQUESTS is the honest code and is what
        // the sibling mod-only limiter (`blocks.retriggerBuild`) already returns.
        code === 'RATE_LIMITED'
        ? 'TOO_MANY_REQUESTS'
        : // 🔴 MAPPED EXPLICITLY even though it lands on the same TRPC code as the
        // default. The default is a FALLTHROUGH, and this table's own note above warns
        // that an unmapped code silently becomes BAD_REQUEST — so an entry here is the
        // difference between "we decided" and "nobody looked". BAD_REQUEST is the honest
        // code: the caller's AUTHORITY is fine (they own the listing and may edit it),
        // it is the specific field in this specific state that is refused, and the
        // message names the field and the way forward. FORBIDDEN would read as "you may
        // not edit this listing", which is exactly the false attribution this arc exists
        // to remove.
        code === 'MATERIAL_CHANGE_BLOCKED'
        ? 'BAD_REQUEST'
        : 'BAD_REQUEST';
    return new TRPCError({ code: trpcCode, message: err.message, cause: err });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred while processing the request. Please try again later.',
    cause: err,
  });
}

export const appListingsRouter = router({
  /**
   * Owner/mod read of a listing's current assets (creator dashboard).
   *
   * 🔴 DELIBERATELY **NOT** `listingMediaCliScope`, and this is the note that keeps it
   * that way. It was annotated during the `civitai app doctor` work and the annotation
   * was then withdrawn as a product decision: its service gate
   * ({@link loadOwnedListing}) SHORT-CIRCUITS for moderators, so admitting a scoped OAuth
   * token here would let a third-party app a moderator authorised inherit that
   * cross-listing reach. `app doctor` does not need it — every datum it wanted is already
   * on annotated procs (`listMine.problems[]` for the advisory + `hasBlockedAsset` /
   * `hasPendingScan` / completeness equivalents; `getMyListingForEdit` /
   * `getMyListingForApp` for per-screenshot `{id, imageId, order, caption}`;
   * `getAssetScanStatuses` for per-image scan state). Re-annotating this proc needs the
   * mod-bypass question answered first, not a copy of a sibling's `.meta(...)`.
   *
   * `app-listings.router.cli-scope.test.ts` asserts a scoped OAuth token is REFUSED here,
   * so the exclusion is behaviourally pinned rather than left to this comment.
   */
  getAssets: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(listingAssetsQuerySchema)
    .query(async ({ ctx, input }) => {
      const { getListingAssets } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return getListingAssets({ listingId: input.listingId }, ctx.user);
    }),

  /**
   * MOD-ONLY: project a SHADOW / pending listing (by its `appListingId` — carried on
   * the review row) into the SAME `ListingCard` + `ListingDetail` store shapes the
   * public `getAppDetail` serves, so the moderator review surface can render the app's
   * REAL media (icon / cover / screenshots) + scalars in store layout BEFORE approval.
   * Read-only, `moderatorProcedure`-gated (the whole review surface is mod-only), NOT
   * status-filtered (unlike the public approved-only read). Returns `null` for an
   * unknown id → the client falls back to a placeholder-art layout preview.
   */
  getListingPreviewForReview: moderatorProcedure
    .input(listingAssetsQuerySchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Listing review preview is restricted to civitai team');
      }
      const { getListingPreviewForReview } = await import(
        '~/server/services/blocks/app-listing.service'
      );
      return getListingPreviewForReview({ listingId: input.listingId });
    }),

  /**
   * Poll the scan status of freshly-attached asset images. The listing-media step
   * attaches an in-flight image IMMEDIATELY (the server stores the pending id), then
   * polls THIS to flip a per-asset "Scanning…" badge to "Scanned" / "Blocked". Owner-
   * scoped in the service (mods read any; a not-owned id is silently omitted).
   */
  getAssetScanStatuses: protectedProcedure
    .meta(listingMediaCliScope)
    .use(enforceAppBlocksAuthorFlag)
    .input(assetScanStatusesSchema)
    .query(async ({ ctx, input }) => {
      const { getAssetScanStatuses } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return getAssetScanStatuses(input.imageIds, ctx.user);
    }),

  // -------------------------------------------------------------------------
  // OWNER ASSET MUTATIONS.
  //
  // 🔴 ALL SIX MAP THROUGH `mapOffsiteError`. Under LAZY shadow-revision minting each
  // of these calls `resolveOwnerAssetEditTarget` → `beginListingRevision`, which
  // throws a typed `OffsiteRequestError` (a plain `Error` subclass, NOT a
  // `TRPCError`) — e.g. `INVALID_REVISION` when a moderator delists the listing
  // between the client's read and this write, or the 'failed to open a revision
  // draft' race. Unwrapped, those surfaced as an opaque 500 with a generic message
  // instead of the typed, actionable one; the escape only exists because the mint
  // moved onto this path. `TRPCError`s the service already shaped (the asset
  // validators, the fail-closed row-id re-map) pass straight through.
  // -------------------------------------------------------------------------

  setIcon: protectedProcedure
    .meta(listingMediaCliScope)
    .use(enforceAppBlocksAuthorFlag)
    .input(setListingIconSchema)
    .mutation(async ({ ctx, input }) => {
      const { setListingIcon } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      try {
        return await setListingIcon(input, ctx.user);
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  setCover: protectedProcedure
    .meta(listingMediaCliScope)
    .use(enforceAppBlocksAuthorFlag)
    .input(setListingCoverSchema)
    .mutation(async ({ ctx, input }) => {
      const { setListingCover } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      try {
        return await setListingCover(input, ctx.user);
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  addScreenshot: protectedProcedure
    .meta(listingMediaCliScope)
    .use(enforceAppBlocksAuthorFlag)
    .input(addListingScreenshotSchema)
    .mutation(async ({ ctx, input }) => {
      const { addListingScreenshot } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      try {
        return await addListingScreenshot(input, ctx.user);
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  reorderScreenshots: protectedProcedure
    .meta(listingMediaCliScope)
    .use(enforceAppBlocksAuthorFlag)
    .input(reorderListingScreenshotsSchema)
    .mutation(async ({ ctx, input }) => {
      const { reorderListingScreenshots } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      try {
        return await reorderListingScreenshots(input, ctx.user);
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * 🔴 Returns `{ id }` = the row that was WRITTEN, which differs from the
   * `screenshotId` passed in when this call minted the shadow revision (the parent row
   * id is re-keyed onto the clone). Treat it as the new id, not an echo. Input schema
   * unchanged — released `civitai` CLI versions calling this under `AppBlocksSubmit`
   * keep working.
   */
  updateScreenshotCaption: protectedProcedure
    .meta(listingMediaCliScope)
    .use(enforceAppBlocksAuthorFlag)
    .input(updateListingScreenshotCaptionSchema)
    .mutation(async ({ ctx, input }) => {
      const { updateListingScreenshotCaption } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      try {
        return await updateListingScreenshotCaption(input, ctx.user);
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * 🔴 Returns `{ removed }` = the row actually DELETED, which differs from the
   * `screenshotId` passed in when this call minted the shadow revision (the clone is
   * deleted, never the live parent's row). Treat it as the new id, not an echo.
   */
  removeScreenshot: protectedProcedure
    .meta(listingMediaCliScope)
    .use(enforceAppBlocksAuthorFlag)
    .input(removeListingScreenshotSchema)
    .mutation(async ({ ctx, input }) => {
      const { removeListingScreenshot } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      try {
        return await removeListingScreenshot(input, ctx.user);
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * Mod-only placeholder backfill for approved listings missing assets.
   * Idempotent + dark + per-row isolated; `dryRun` previews without writing.
   */
  backfillAssets: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(backfillListingAssetsSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Listing asset backfill is restricted to civitai team');
      }
      const { backfillListingAssets } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return backfillListingAssets({ limit: input.limit, dryRun: input.dryRun });
    }),

  // -------------------------------------------------------------------------
  // P3a OFF-SITE SUBMISSION (external-link) — DARK behind `app-blocks-author`.
  //
  // The native publish-request flow for a pure external-link off-site app
  // (design B1: submit creates a DRAFT AppListing + a pending
  // AppListingPublishRequest in one tx). AUTHOR procs (submit/withdraw/
  // my-submissions) are `appDeveloperProcedure` (mods + app-dev-testers); the
  // read-only review-queue lists are `moderatorProcedure`. approve/reject land in
  // PR-b. Nothing renders any UI in this PR.
  // -------------------------------------------------------------------------

  /**
   * AUTHOR: submit an external-app off-site listing (the MERGED external+connect
   * model — every external app links its own OAuth client). REQUIRES the caller's
   * OAuth `connectClientId` (owned, not an App-Block client) + the disclosed
   * requested-scope subset (⊆ the client's `allowedScopes`) + per-scope
   * justifications; `externalUrl` is an OPTIONAL homepage / Visit link. Creates a
   * DRAFT `AppListing` + a `pending` `AppListingPublishRequest` (B1); the author then
   * attaches assets via the (author-gated) asset-CRUD procs above before a mod
   * approves it. Owner-bound to the caller (no user-supplied owner).
   */
  submitExternalListing: appDeveloperProcedure
    .use(
      rateLimit({
        // A row-creating write reachable by non-mod dev-testers — heavier than
        // the store reads, so a conservative hourly cap throttles draft-spam /
        // slug-squat. The per-user PENDING cap in the service bounds the standing
        // orphan-draft count; this bounds the submit RATE.
        limit: 10,
        period: 3600,
        errorMessage: 'Too many submissions — slow down.',
      })
    )
    .input(submitExternalListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { submitExternalListing } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      // `isModerator` lets a mod link ANY (non-App-Block) OAuth client on submit —
      // mirroring the mod-only global client search (`oauthClient.searchForModerator`).
      // A non-mod stays restricted to their own clients (default `false`).
      return submitExternalListing({
        input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });
    }),

  /**
   * AUTHOR: withdraw the caller's OWN pending off-site request (terminal). IDOR +
   * TOCTOU checked in the service; deletes the draft listing (releases the slug).
   * Idempotent. All failure modes map to BAD_REQUEST with the service message
   * (mirrors `blocks.withdrawPublishRequest`).
   */
  withdrawExternalRequest: appDeveloperProcedure
    .input(withdrawExternalRequestSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { withdrawExternalRequest } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      let outcome;
      try {
        ({ outcome } = await withdrawExternalRequest({
          publishRequestId: input.publishRequestId,
          userId: ctx.user.id,
        }));
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: (err as Error).message,
          cause: err,
        });
      }
      // 🔴 `outcome` is NOT decoration. `'removed'` means this withdraw closed the review
      // of a formerly-LIVE listing, which leaves it delisted and only a moderator can put
      // it back; `'deleted'` merely discarded a draft. The UI must be able to say which,
      // so it is returned rather than collapsed into `{ ok: true }`.
      return { ok: true, outcome };
    }),

  /**
   * AUTHOR: edit an existing off-site listing WITHOUT withdrawing it (state-aware).
   * draft/pending → in place; approved-trivial (tagline/description/category/
   * contentRating) → in place; approved-material (externalUrl/name) → staged on a
   * shadow-draft revision (`requiresReview:true` + the `shadowId` to edit assets
   * against, then `submitListingRevision`). Owner-bound in the service. Rejected →
   * MUST_RESUBMIT. `removed` is SPLIT: a moderator takedown → FORBIDDEN, an OWNER
   * self-unpublish → trivial fields edit in place and a MATERIAL field →
   * MATERIAL_CHANGE_BLOCKED. Typed failures map via `mapOffsiteError`.
   *
   * ## CLI-reachable (`listingMediaCliScope`) — a WRITE, so the three checks stated
   *
   * `civitai app doctor` reports `empty-description` / `empty-tagline` / `empty-category`;
   * this is the only proc that can FIX them, so leaving it un-annotated would ship a
   * read-only diagnosis of problems the CLI cannot act on.
   *
   *   (a) AUTHORITY IS INDEPENDENT OF TOKEN SCOPE. `loadOwnedEditableListing` →
   *       `resolveListingRole` → `resolveListingAccess` admits the listing's OWNER or an
   *       ACCEPTED collaborator, and NOTHING else — there is not even a moderator
   *       override on this path. The meta changes which CREDENTIAL may speak for that
   *       caller, never who the caller may act for.
   *   (b) IT CANNOT MUTATE ANYTHING A MODERATOR OWNS. Every write funnels through
   *       `buildListingPatchData`, whose entire output surface is author-owned scalars
   *       (externalUrl / sourceRepoUrl / name / tagline / description / category /
   *       contentRating / the derived connect-scope snapshot). No `status`, no
   *       moderation event, no publish-request row. A `rejected` listing is steered to
   *       resubmit; a `removed` one is refused (FORBIDDEN) when a MODERATOR took it down.
   *   (c) IT CANNOT PUT AN UNREVIEWED MATERIAL VALUE ON THE STORE, IN EITHER OF THE TWO
   *       STATES THAT LOOK EDITABLE. This is the claim that actually carries the scope
   *       annotation, so it is stated by mechanism rather than by status:
   *         - `approved` + MATERIAL → staged onto a shadow via `beginListingRevision`;
   *           the live parent is untouched until a moderator approves the revision. Only
   *           trivial edits touch an approved row in place.
   *         - `removed` + last status-changing event `owner-unpublish` (the owner's own
   *           repair state, which this proc now admits) + MATERIAL →
   *           MATERIAL_CHANGE_BLOCKED, refused. It is NOT applied and NOT staged. This
   *           refusal is what stops the owner-driven loop `approved` →
   *           `unpublishOwnListing` → patch `externalUrl`/`contentRating` in place →
   *           `republishOwnListing` → `approved`, which would otherwise swap the store's
   *           destination or lower its content rating after approval. Neither republish
   *           gate is a content review (one checks image scans, the other that an https
   *           href exists), so the refusal — not the republish path — is the guarantee.
   *         - A shadow passed here is REFUSED (`revisionOfId != null` →
   *           INVALID_REVISION) — shadows are `updateRevisionDraft`'s job.
   *       Net: the ONLY route from a token to a changed material value on a live store
   *       page still runs through moderator re-approval.
   *
   * 🔴 The scope-disclosure keys (`requestedScopes`/`scopeJustifications`) are reachable
   * through this patch, but they are SERVER-DERIVED: `deriveScopePatch` re-resolves the
   * linked OAuth client's `allowedScopes` ceiling and `assertConnectScopesValid` re-checks
   * the subset + justifications, so a token cannot request a scope its client does not
   * already allow. A scope change is MATERIAL, so it follows (c): on `approved` it routes
   * to a shadow, on an owner-unpublished `removed` it is refused.
   */
  updateListing: appDeveloperProcedure
    .meta(listingMediaCliScope)
    .use(
      rateLimit({
        limit: 30,
        period: 3600,
        errorMessage: 'Too many edits — slow down.',
      })
    )
    .input(updateListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { updateListing } = await import('~/server/services/blocks/offsite-listing.service');
      try {
        return await updateListing({
          listingId: input.listingId,
          patch: input.patch,
          userId: ctx.user.id,
          // Mirror the mod-only client search: a mod editing a listing that links a
          // foreign OAuth client isn't blocked by the owner re-assertion.
          isModerator: ctx.user.isModerator,
        });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * AUTHOR: owner-gated prefill read for the dual-mode edit wizard
   * (`/apps/submit?edit=<listingId>`). Returns the listing's scalars + current
   * assets (edge-resolved) + status + hasPendingRevision, resolving an approved
   * parent's in-progress shadow so a resumed revision prefills its edited state.
   * Owner-bound in the service (NOT_OWNED→FORBIDDEN, NOT_FOUND, rejected→
   * MUST_RESUBMIT/BAD_REQUEST). `removed` is SPLIT on the last status-changing moderation
   * event: a moderator takedown → FORBIDDEN, the owner's own `owner-unpublish` → the
   * prefill resolves (the listing is in the owner's repair state). It agrees with
   * `updateListing`'s gate by construction — both read the same predicate — so this read
   * never hands back an editor the write path then refuses. Note the prefill is still
   * WIDER than what the write accepts: a material field prefills but cannot be SAVED while
   * unpublished (MATERIAL_CHANGE_BLOCKED), which is deliberate — the author has to be able
   * to SEE the current value of a field they may not change. Typed failures via
   * `mapOffsiteError`.
   */
  getMyListingForEdit: appDeveloperProcedure
    .meta(listingMediaCliScope)
    .input(getMyListingForEditSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { getMyListingForEdit } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      try {
        return await getMyListingForEdit({ listingId: input.listingId, userId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * AUTHOR: write a scalar patch to an owned DRAFT shadow revision (the approved
   * edit flow's "direct once shadow exists" scalar write, symmetric with the asset
   * procs that already mutate an owned shadow). Owner-bound in the service; asserts
   * the target is a draft shadow so it can never edit a live top-level listing.
   * Typed failures map via `mapOffsiteError`.
   *
   * ## CLI-reachable (`listingMediaCliScope`) — same three checks as `updateListing`
   *
   * The CLI's asset procs (`setIcon`/`setCover`/`addScreenshot`) already take a shadow id
   * and are already annotated; without this one the SCALAR half of a shadow edit stays
   * 403 for the same token, so `civitai app doctor --fix` could repair an approved app's
   * media but not its tagline.
   *
   *   (a) Same `loadOwnedEditableListing` owner/seat gate, no moderator override.
   *   (b) Same `buildListingPatchData` write surface — author-owned scalars only.
   *   (c) Strictly TIGHTER on the revision model than `updateListing`: it REFUSES a
   *       top-level listing (`revisionOfId == null` → INVALID_REVISION) and refuses a
   *       shadow that is not still `draft`, so it can only ever write a not-yet-submitted
   *       revision draft the caller owns. It cannot touch a live parent at all.
   */
  updateRevisionDraft: appDeveloperProcedure
    .meta(listingMediaCliScope)
    .use(
      rateLimit({
        limit: 30,
        period: 3600,
        errorMessage: 'Too many edits — slow down.',
      })
    )
    .input(updateRevisionDraftSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { updateRevisionDraft } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      try {
        return await updateRevisionDraft({
          shadowId: input.shadowId,
          patch: input.patch,
          userId: ctx.user.id,
          // Mirror the mod-only client search (same rationale as `updateListing`).
          isModerator: ctx.user.isModerator,
        });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * OWNER: resolve the caller's OWN listing by its backing `appBlockId` OR by its public
   * `slug` — the entry read for the owner-facing on-site listing-media page
   * (`/apps/<appBlockId>/listing`) and for non-web clients that only hold a slug.
   * `appBlockId` takes PRECEDENCE: the slug arm runs only when it missed or was absent,
   * and it resolves any TOP-LEVEL listing (either kind, any status) — civitai/civitai#3984.
   * Returns the `AppListing.id` the page passes to `beginListingRevision` + the asset
   * procs, plus the listing status / content rating / whether a revision is already
   * under review, AND the EDITABLE target's current assets (`assets` + `shadowId`) so
   * the media editor can prefill the icon/cover/screenshots it is about to edit and
   * evaluate its publish floor. Owner-bound in the service (the assets are the
   * CALLER'S OWN listing only — nothing here is exposed to a public listing DTO);
   * typed failures map via `mapOffsiteError` (NOT_OWNED→FORBIDDEN, NOT_FOUND when no
   * listing row exists for the app).
   *
   * Rate-limited because the SLUG arm resolves any top-level listing and its two
   * outcomes are distinguishable (NOT_OWNED→FORBIDDEN vs NOT_FOUND), i.e. it answers
   * "does this slug exist?" for rows the public catalogue never shows — civitai#4003.
   * Bounding is defence-in-depth, not closure: `submitExternalListing`'s
   * `slugTakenError` is the same oracle at 10/hour. See the enforcement matrix in
   * `app-listings.router.getMyListingForApp.rate-limit.test.ts` — both numbers are
   * pinned there, so change them together.
   */
  getMyListingForApp: appDeveloperProcedure
    .meta(listingMediaCliScope)
    .use(
      rateLimit({
        // A READ limit, shaped like this router's other reads (`getAppDetail`,
        // `listAvailable`, `listReviews` are all 60/60) rather than like the hourly
        // write caps — it must not interrupt authoring. The media editor invalidates
        // this query after EVERY asset mutation, and the heaviest legitimate burst
        // (a screenshot batch + icon + cover + reorders) is well under a refetch a
        // second; the CLI calls it once per `app listing`. 60/60 clears both with
        // room, while turning an unbounded enumeration into a metered one.
        limit: 60,
        period: 60,
        errorMessage: 'Too many listing lookups — slow down.',
      })
    )
    .input(getMyListingForAppSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { getMyListingForApp } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      try {
        return await getMyListingForApp({
          appBlockId: input.appBlockId,
          slug: input.slug,
          userId: ctx.user.id,
        });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * AUTHOR: open (or re-open) a shadow-draft revision of an APPROVED listing so its
   * MATERIAL fields / assets can be edited while the current version stays live.
   * Idempotent (re-opening returns the existing shadow). Returns the shadow id;
   * the author then edits its assets via `setIcon`/`setCover`/`addScreenshot`
   * (passing the shadow id) and calls `submitListingRevision`.
   */
  beginListingRevision: appDeveloperProcedure
    .meta(listingMediaCliScope)
    .input(beginListingRevisionSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { beginListingRevision } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      try {
        return await beginListingRevision({ listingId: input.listingId, userId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * AUTHOR: submit a prepared shadow-draft revision for mod re-approval. Asserts
   * the shadow is a draft revision, asset-complete + URL-valid, then creates a
   * pending publish request pointing at the shadow but carrying the PUBLIC PARENT
   * slug. Guards a second concurrent pending revision. Typed failures map via
   * `mapOffsiteError`.
   */
  submitListingRevision: appDeveloperProcedure
    .meta(listingMediaCliScope)
    .use(
      rateLimit({
        limit: 20,
        period: 3600,
        errorMessage: 'Too many revision submissions — slow down.',
      })
    )
    .input(submitListingRevisionSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { submitListingRevision } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      try {
        return await submitListingRevision({
          shadowId: input.shadowId,
          userId: ctx.user.id,
          changelog: input.changelog,
        });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * AUTHOR: persist a CF-uploaded image → `Image` row, returning its numeric id
   * for the submit form's asset step (which then attaches it to the draft listing
   * via `setIcon`/`setCover`/`addScreenshot`). Author-gated (mods + app-dev-testers)
   * + rate-limited; the row is owned by the caller and the attach proc's owner +
   * per-kind-image validation still bounds where/whether it can be used.
   */
  persistAssetImage: appDeveloperProcedure
    .meta(listingMediaCliScope)
    .use(
      rateLimit({
        limit: 60,
        period: 3600,
        errorMessage: 'Too many image uploads — slow down.',
      })
    )
    .input(persistListingAssetImageSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { persistListingAssetImage } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      return persistListingAssetImage({ input, userId: ctx.user.id });
    }),

  /**
   * AUTHOR: SSRF-safe metadata auto-pull for the submit form. Given an external
   * listing URL, server-side fetches the target page (hardened `safeFetch`:
   * https-only + DNS-resolved-public + manual-redirect-revalidate + timeout + size
   * cap + text/html allowlist) and returns SUGGESTIONS (name / tagline + cover/icon
   * image URLs). Nothing is persisted — the author accepts or overrides. Never
   * throws on "nothing found" (returns empty fields); SSRF/timeout/size failures
   * map to a friendly BAD_REQUEST with no internal detail leaked. Rate-limited
   * (~30/hr) — it triggers an outbound fetch per call.
   */
  fetchListingMetaFromUrl: appDeveloperProcedure
    .use(
      rateLimit({
        limit: 30,
        period: 3600,
        errorMessage: 'Too many preview lookups — slow down.',
      })
    )
    .input(fetchListingMetaSchema)
    .query(async ({ input }) => {
      const { fetchListingMeta } = await import('~/server/services/blocks/listing-meta.service');
      return fetchListingMeta(input);
    }),

  /**
   * AUTHOR: ingest an ACCEPTED suggested image URL into a scannable `Image` row.
   * The remote URL is attacker-influenced + cross-origin, so the SERVER pulls the
   * bytes (SSRF-safe) → uploads to CF → `createImage` through the STANDARD scan
   * pipeline (default ingestion, NO skipIngestion / NO scan bypass) and returns the
   * numeric `imageId`. The client then attaches it via `setIcon`/`setCover` (which
   * enforce `ingestion === Scanned` + per-kind validation), polling until Scanned —
   * exactly like an author-uploaded asset. Rate-limited (~30/hr, outbound fetch +
   * CF upload per call). Ownership is bound to the caller.
   */
  ingestAssetFromUrl: appDeveloperProcedure
    .use(
      rateLimit({
        limit: 30,
        period: 3600,
        errorMessage: 'Too many image imports — slow down.',
      })
    )
    .input(ingestListingAssetFromUrlSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { ingestListingAssetFromUrl } = await import(
        '~/server/services/blocks/listing-meta.service'
      );
      return ingestListingAssetFromUrl({ input, userId: ctx.user.id });
    }),

  /**
   * AUTHOR: ingest an ACCEPTED inline `data:image/...` icon (a favicon declared as a
   * data URI — the https-only URL path drops these) into a scannable `Image` row.
   * The bytes come from the data URI itself (no outbound fetch); the server decodes,
   * REJECTS any non-image MIME, caps the decoded size, and RASTERIZES to PNG (raw SVG
   * is never stored/served — XSS vector) before running the STANDARD scan pipeline.
   * Returns the numeric `imageId` the client then attaches via `setIcon`. Same auth +
   * rate-limit shape as the URL accept.
   */
  ingestAssetFromDataUri: appDeveloperProcedure
    .meta(listingMediaCliScope)
    .use(
      rateLimit({
        limit: 30,
        period: 3600,
        errorMessage: 'Too many image imports — slow down.',
      })
    )
    .input(ingestListingAssetFromDataUriSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { ingestListingAssetFromDataUri } = await import(
        '~/server/services/blocks/listing-meta.service'
      );
      return ingestListingAssetFromDataUri({ input, userId: ctx.user.id });
    }),

  /** AUTHOR: the caller's OWN off-site submissions (my-submissions page, PR-c). */
  listMySubmissions: appDeveloperProcedure
    .input(listMySubmissionsSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user) return { items: [], nextCursor: null };
      const { listMySubmissions } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      return listMySubmissions({ userId: ctx.user.id, limit: input.limit, cursor: input.cursor });
    }),

  /**
   * AUTHOR: every APP LISTING the caller owns or holds an ACCEPTED editor seat on.
   *
   * 🔴 NOT a variant of `listMySubmissions`, and the two must not be conflated. That one
   * is scoped to a publish request's `submittedByUserId` — "what did I submit" — so a
   * listing acquired by ownership TRANSFER or by a moderator `claimListing` is invisible
   * there to the person who now owns it, and a COLLABORATOR (who submitted nothing) sees
   * nothing at all. This is the ownership-and-seats read the authoring entry points need.
   *
   * Each row carries its `role` and its KIND-DERIVED `capabilities`, so the client
   * renders only surfaces that will not 403.
   *
   * `appDeveloperProcedure` = the App Blocks author FLAG (`protectedProcedure.use(
   * hasAppBlocksAuthor)`), NOT an ownership check — which is what makes it correct for a
   * seat-only caller who owns nothing. Same gate the collaborator router composes.
   *
   * CLI-reachable (`listingMediaCliScope`): THE read behind `civitai app doctor`. It is
   * the only surface carrying `problems[]` (the 8-code completeness advisory) plus
   * `lastModerationAction`, so without the meta the CLI's OAuth token 403s on the one
   * proc that can tell an author what is wrong with their listing. The set it returns is
   * resolved from ownership ∪ accepted seats in the service; the meta admits a credential,
   * it does not widen that set.
   */
  listMine: appDeveloperProcedure.meta(listingMediaCliScope).query(async ({ ctx }) => {
    if (!ctx.user) return [];
    const { listMyAppListings } = await import('~/server/services/blocks/app-access.service');
    return listMyAppListings({ userId: ctx.user.id });
  }),

  /**
   * AUTHOR: the authoring context for ONE listing — the read behind the canonical
   * `/apps/listing/<appListingId>/edit` page.
   *
   * Refuses (FORBIDDEN) a caller with no role rather than returning a role-less row, so
   * the page can never render a tab set for someone every child query would refuse. A
   * SHADOW revision id resolves to its PARENT.
   */
  getAuthoringContext: appDeveloperProcedure
    .input(appListingAuthoringContextSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { getAppListingAuthoringContext } = await import(
        '~/server/services/blocks/app-access.service'
      );
      return getAppListingAuthoringContext({
        appListingId: input.appListingId,
        userId: ctx.user.id,
      });
    }),

  /**
   * AUTHOR: ONE listing's full publish history — the LAZY, per-row read behind the merged
   * `/apps/mine` table's expandable rows.
   *
   * 🔴 PER-LISTING AND FETCHED ON EXPAND, deliberately. The page it replaced issued TWO
   * unbounded per-user queries on mount (`blocks.listMyPublishRequests`, which fans out to
   * four more queries, plus `appListings.listMySubmissions`) to render history nobody had
   * asked to see. Here the table renders from `listMine` alone and this proc runs only for
   * the row the caller actually opened.
   *
   * 🔴 NOT gated on the marketplace `appBlocks` flag — `appDeveloperProcedure`
   * (`app-blocks-author`) only, matching the merged page's own SSR gate. `appBlocks` is
   * store VISIBILITY; requiring it would blank an author's own history whenever store
   * access is narrowed. (`blocks.listMyPublishRequests` carries `enforceAppBlocksFlag`,
   * which is why it is not the read used here.)
   *
   * The union-of-two-tables reasoning lives in the service's module header — read it before
   * changing either query.
   */
  listingHistory: appDeveloperProcedure
    // Same `{ appListingId }` shape and bounds as `getAuthoringContext`; a second identical
    // schema would just be a second thing to keep in step.
    .input(appListingAuthoringContextSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { listListingHistory } = await import(
        '~/server/services/blocks/app-listing-history.service'
      );
      return listListingHistory({ appListingId: input.appListingId, userId: ctx.user.id });
    }),

  /**
   * AUTHOR: the caller's own submissions whose LISTING NO LONGER EXISTS.
   *
   * 🔴 THE ONE DELIBERATELY SUBMITTER-SCOPED READ ON THIS PAGE, and the exception proves
   * the rule. Every other read here is ownership∪seat because an app exists to key on; a
   * first version that was rejected or withdrawn had its pre-approval DRAFT listing
   * DELETED (the slug release), so there is no app row left and `submitted_by_user_id` is
   * the only identity the surviving record carries. Without this proc that population is
   * unreachable from anywhere in the product — including from the "your app was rejected"
   * notification, which now points here.
   *
   * Same `appBlocksAuthor`-only gate as the page and `listingHistory`.
   */
  listMyOrphanedSubmissions: appDeveloperProcedure.query(async ({ ctx }) => {
    if (!ctx.user) return [];
    const { listMyOrphanedSubmissions } = await import(
      '~/server/services/blocks/app-listing-history.service'
    );
    return listMyOrphanedSubmissions({ userId: ctx.user.id });
  }),

  /** MOD: pending off-site review queue (read-only in PR-a; approve/reject in PR-b). */
  listPendingRequests: moderatorProcedure
    .input(listOffsiteRequestsSchema)
    .query(async ({ input }) => {
      const { listPendingOffsiteRequests } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      return listPendingOffsiteRequests(input);
    }),

  /** MOD: approved off-site request history. */
  listApprovedRequests: moderatorProcedure
    .input(listOffsiteRequestsSchema)
    .query(async ({ input }) => {
      const { listApprovedOffsiteRequests } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      return listApprovedOffsiteRequests(input);
    }),

  /** MOD: rejected off-site request history. */
  listRejectedRequests: moderatorProcedure
    .input(listOffsiteRequestsSchema)
    .query(async ({ input }) => {
      const { listRejectedOffsiteRequests } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      return listRejectedOffsiteRequests(input);
    }),

  /**
   * MOD: approve a pending off-site request (PR-b). Loads the request + its draft
   * listing, enforces `assertListingMeetsFloor` (approve FAILS unless icon+cover;
   * screenshots are OPTIONAL — partial-media relaxation) + re-validates the stored externalUrl,
   * then flips the listing draft→approved + the request→approved (status-guarded)
   * and supersedes sibling pendings. v1 ALLOWS mod self-approve (reviewer ==
   * submitter — trusted, enables single-mod dogfood; a reviewer≠submitter
   * restriction is deferred to GA/P3b). Failure modes are mapped by
   * `mapOffsiteError`: typed NOT_FOUND→NOT_FOUND, NOT_PENDING/assets-incomplete/
   * bad-URL→BAD_REQUEST, and any unexpected infra error→INTERNAL_SERVER_ERROR
   * (generic message, no raw leak).
   */
  approveExternalRequest: moderatorProcedure
    .input(approveExternalRequestSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError(
          'Approving standalone listings is restricted to civitai team'
        );
      }
      const { approveExternalRequest } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      try {
        return await approveExternalRequest({
          publishRequestId: input.publishRequestId,
          reviewerUserId: ctx.user.id,
          approvalNotes: input.approvalNotes,
          contentRating: input.contentRating,
        });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * MOD: reject a pending off-site request (PR-b). Requires `rejectionReason`
   * ≥`OFFSITE_REJECTION_REASON_MIN` (the shared `OFFSITE_MOD_REASON_MIN`, 3)
   * chars; in ONE tx flips the request→rejected + sets `reviewedBy*` and DELETES
   * the draft listing (status-guarded — releases the slug, never removes an
   * approved listing). Failure modes are mapped by `mapOffsiteError` (typed
   * NOT_FOUND→NOT_FOUND, NOT_PENDING/reason-length→BAD_REQUEST, unexpected→
   * INTERNAL_SERVER_ERROR with a generic message).
   */
  rejectExternalRequest: moderatorProcedure
    .input(rejectExternalRequestSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError(
          'Rejecting standalone listings is restricted to civitai team'
        );
      }
      const { rejectExternalRequest } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      try {
        await rejectExternalRequest({
          publishRequestId: input.publishRequestId,
          reviewerUserId: ctx.user.id,
          rejectionReason: input.rejectionReason,
        });
      } catch (err) {
        throw mapOffsiteError(err);
      }
      return { ok: true };
    }),

  // -------------------------------------------------------------------------
  // P3b OFF-SITE MODERATION — report affordance + mod report-queue read (DARK).
  //
  // `reportListing` is any-signed-in-user (`protectedProcedure`) + rate-limited
  // (report-spam guard) — the reporter is bound to `ctx.user.id` in the service
  // (IDOR-safe) and the DB partial-unique dedups a duplicate open report.
  // `listListingReports` is a read-only `moderatorProcedure`. The mod ACTIONS
  // (delist / relist / claim / resolve / dismiss + the audit writes) land in PR3.
  // -------------------------------------------------------------------------

  /**
   * USER: report an approved off-site listing. The reporter is bound to the
   * caller (no user-supplied reporter — IDOR guard); the DB partial-unique
   * (`one_open_per_reporter`) dedups a duplicate open report → a friendly
   * CONFLICT via `mapOffsiteError`. Reporting a non-approved / missing listing →
   * NOT_REPORTABLE(BAD_REQUEST) / NOT_FOUND. Unexpected infra → INTERNAL (no leak).
   */
  reportListing: protectedProcedure
    .use(
      rateLimit({
        // Report-spam guard (mirrors the submit rate-limit idiom). The DB
        // one-open-report-per-(listing,reporter) partial-unique bounds duplicate
        // reports; this bounds the report RATE across listings.
        limit: 20,
        period: 3600,
        errorMessage: 'Too many reports — slow down.',
      })
    )
    .input(reportListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { reportListing } = await import('~/server/services/blocks/offsite-moderation.service');
      try {
        return await reportListing({ input, userId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * MOD: the off-site report queue (read-only in PR2; the delist/claim/resolve
   * actions land in PR3). Oldest-first (FIFO), keyset-paginated, optional `status`
   * filter; a public-safe projection (reporter chip + target listing slug/name/
   * kind — no PII/secret).
   */
  listListingReports: moderatorProcedure
    .input(listListingReportsSchema)
    .query(async ({ input }) => {
      const { listListingReports } = await import(
        '~/server/services/blocks/offsite-moderation.service'
      );
      return listListingReports(input);
    }),

  // -------------------------------------------------------------------------
  // P3b PR3/PR4 mod ACTIONS — delist / relist / claim / purge / resolve / dismiss.
  //
  // Posture: UI-dark (the mod takedown affordance renders only on the mod-only
  // store-preview surface). The SERVER gate is `moderatorProcedure` + the inner
  // `isModerator` recheck (belt + braces, mirroring approve/reject) — NOT the
  // `app-blocks-enabled` flag: that flag darkens the UI only, and mods bypass it
  // anyway, so `enforceAppBlocksFlag` here would be inert (deliberately omitted).
  // Plus `mapOffsiteError` (typed → TRPC code, no infra leak). The reviewer is bound
  // to `ctx.user.id` — never client-supplied. Each writes exactly one
  // `AppListingModerationEvent` in the same tx as its mutation. `claimListing` (PR4)
  // reassigns ownership — there is NO self-service claim endpoint (mod-only is the
  // whole boundary). All offsite-only.
  // -------------------------------------------------------------------------

  /**
   * MOD delist an approved off-site listing (approved → removed). Drops out of the
   * approved-only store read path automatically. Optionally resolves a linked
   * `reportId` in the same tx. Typed failures map via `mapOffsiteError`
   * (NOT_FOUND→NOT_FOUND, NOT_TRANSITIONABLE→BAD_REQUEST, infra→INTERNAL/no leak).
   */
  delistListing: moderatorProcedure.input(delistListingSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.user?.isModerator) {
      throw throwAuthorizationError('Delisting standalone listings is restricted to civitai team');
    }
    const { delistListing } = await import('~/server/services/blocks/offsite-moderation.service');
    try {
      return await delistListing({ input, reviewerUserId: ctx.user.id });
    } catch (err) {
      throw mapOffsiteError(err);
    }
  }),

  /**
   * MOD send the app's OWNER a free-text message, delivered as a notification.
   *
   * The only mod action here that changes no listing state — it exists because the
   * eleven app notification types are all event-triggered with fixed copy, so a
   * moderator who needed to tell a developer something the platform has no event for
   * had no in-product route at all (see `app-moderator-message.service.ts`).
   *
   * Same boundary as its neighbours: `moderatorProcedure` + the inner `isModerator`
   * recheck, `moderatorUserId` bound to `ctx.user.id` (never client-supplied), one
   * `AppListingModerationEvent` per send, and `mapOffsiteError` for typed failures
   * (NOT_FOUND→NOT_FOUND, RATE_LIMITED→TOO_MANY_REQUESTS, BLOCKED_LINK/INVALID_TEXT→
   * BAD_REQUEST, infra→INTERNAL with no leak).
   *
   * 🔴 NO `rateLimit()` MIDDLEWARE HERE ON PURPOSE — it short-circuits for moderators
   * and would cap nothing while looking like a limit. The real ceilings are the two
   * Redis windows spent inside the service
   * (`~/server/utils/app-moderator-message-rate-limit`).
   *
   * DUAL-KIND: works for an on-site or an off-site listing, and accepts a shadow
   * revision id (resolved to its parent), because the owner resolver handles all three
   * and a moderator should not have to know which they pasted.
   */
  messageAppOwner: moderatorProcedure
    .input(messageAppOwnerSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Messaging app owners is restricted to civitai team');
      }
      const { messageAppOwner } = await import(
        '~/server/services/blocks/app-moderator-message.service'
      );
      try {
        return await messageAppOwner({ input, moderatorUserId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /** MOD relist a removed off-site listing (removed → approved). Reversibility. */
  relistListing: moderatorProcedure.input(relistListingSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.user?.isModerator) {
      throw throwAuthorizationError('Relisting standalone listings is restricted to civitai team');
    }
    const { relistListing } = await import('~/server/services/blocks/offsite-moderation.service');
    try {
      return await relistListing({ input, reviewerUserId: ctx.user.id });
    } catch (err) {
      throw mapOffsiteError(err);
    }
  }),

  /**
   * MOD claim (reassign ownership of) an approved/removed off-site listing (PR4) —
   * the mod-arbitrated ownership transfer. Reassigns `AppListing.userId` to a
   * mod-verified `targetUserId`; the historical `AppListingPublishRequest`
   * submitter is left INTACT. `moderatorProcedure` + `isModerator` recheck is the
   * WHOLE trust boundary — there is deliberately NO `protectedProcedure` self-claim
   * endpoint (a user cannot claim their own listing). Typed failures map via
   * `mapOffsiteError` (NOT_FOUND→NOT_FOUND, NOT_TRANSITIONABLE/INVALID_TARGET_USER→
   * BAD_REQUEST, infra→INTERNAL with no leak).
   */
  claimListing: moderatorProcedure.input(claimListingSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.user?.isModerator) {
      throw throwAuthorizationError(
        'Reassigning standalone listings is restricted to civitai team'
      );
    }
    const { claimListing } = await import('~/server/services/blocks/offsite-moderation.service');
    try {
      return await claimListing({ input, reviewerUserId: ctx.user.id });
    } catch (err) {
      throw mapOffsiteError(err);
    }
  }),

  /**
   * MOD hard-delete (purge) a listing — the final expunge + the self-clean primitive.
   * Valid targets are any OFF-SITE listing, or an ON-SITE **orphan pre-approval draft**
   * (never approved, not a shadow revision). The on-site arm exists because
   * `rejectRequest` no longer deletes that draft as a side-effect (clawgate #302), so a
   * mod who genuinely wants a rejected submission's slug and media gone asks for it here
   * — with a reason and an audit event — instead of it riding on every reject.
   * Anything else (an approved/removed on-site listing, a shadow revision, a missing
   * row) raises the same generic NOT_FOUND, so a caller cannot probe kind or status.
   *
   * Writes the audit event BEFORE the delete so the event row
   * survives at the ROW level for audit/compliance (SetNull FK + slug snapshot). It
   * is NOT retrievable via the per-listing history read (`listModerationEvents`)
   * once purged — the FK is nulled, so post-purge it's reachable only via the actor
   * index / raw SQL (a slug-keyed orphaned-events read path is deferred to pre-GA).
   * Destructive — the UI gates it behind a confirm.
   */
  purgeListing: moderatorProcedure.input(purgeListingSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.user?.isModerator) {
      throw throwAuthorizationError('Purging standalone listings is restricted to civitai team');
    }
    const { purgeListing } = await import('~/server/services/blocks/offsite-moderation.service');
    try {
      return await purgeListing({ input, reviewerUserId: ctx.user.id });
    } catch (err) {
      throw mapOffsiteError(err);
    }
  }),

  /** MOD resolve a pending report (pending → resolved) + audit event. */
  resolveReport: moderatorProcedure.input(resolveReportSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.user?.isModerator) {
      throw throwAuthorizationError('Resolving reports is restricted to civitai team');
    }
    const { resolveReport } = await import('~/server/services/blocks/offsite-moderation.service');
    try {
      await resolveReport({ input, reviewerUserId: ctx.user.id });
    } catch (err) {
      throw mapOffsiteError(err);
    }
    return { ok: true };
  }),

  /** MOD dismiss a pending report (pending → dismissed) + audit event. */
  dismissReport: moderatorProcedure.input(dismissReportSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.user?.isModerator) {
      throw throwAuthorizationError('Dismissing reports is restricted to civitai team');
    }
    const { dismissReport } = await import('~/server/services/blocks/offsite-moderation.service');
    try {
      await dismissReport({ input, reviewerUserId: ctx.user.id });
    } catch (err) {
      throw mapOffsiteError(err);
    }
    return { ok: true };
  }),

  /** MOD per-listing moderation history (audit trail), newest-first, keyset. */
  listModerationEvents: moderatorProcedure
    .input(listModerationEventsSchema)
    .query(async ({ input }) => {
      const { listModerationEvents } = await import(
        '~/server/services/blocks/offsite-moderation.service'
      );
      return listModerationEvents(input);
    }),

  // -------------------------------------------------------------------------
  // W13 POST-APPROVAL LISTING MANAGEMENT (Phase 1) — DARK.
  //
  // `resetListingToPending` is a MOD action (`moderatorProcedure` + `isModerator`
  // recheck, same posture as delist/relist/claim/purge). The three owner procs
  // (`unpublishOwnListing` / `republishOwnListing` / `listMyListingModerationEvents`)
  // are `appDeveloperProcedure` (mods + app-dev-testers) and are bound to the caller
  // in the service (owner-only, else NOT_OWNED → FORBIDDEN). All typed failures map
  // via `mapOffsiteError` (no infra leak). Offsite-only in the service.
  // -------------------------------------------------------------------------

  /**
   * MOD reset an approved off-site listing back into the review queue (approved →
   * pending) — mints a fresh pending publish request owned by the listing owner so a
   * mod can re-approve/reject it through the existing flow, writes a `reset-to-pending`
   * audit event, and notifies the owner. Typed failures map via `mapOffsiteError`
   * (NOT_FOUND→NOT_FOUND, NOT_TRANSITIONABLE→BAD_REQUEST, infra→INTERNAL/no leak).
   */
  resetListingToPending: moderatorProcedure
    .input(resetListingToPendingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError(
          'Resetting standalone listings is restricted to civitai team'
        );
      }
      const { resetListingToPending } = await import(
        '~/server/services/blocks/offsite-moderation.service'
      );
      try {
        return await resetListingToPending({ input, reviewerUserId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * MOD reset an approved ON-SITE (hosted app-block) listing back into the block
   * review queue (approved → pending) — the W13-deferred onsite reset, now built.
   * Suspends the backing block (the real runtime stop), clones the latest approved
   * `AppBlockPublishRequest` into a fresh pending one (assets/version KEPT, NO owner
   * resubmit) so it re-enters `listPendingRequests`, writes a `reset-to-pending` audit
   * event, and notifies the owner; a mod re-approves it through the existing block
   * review flow (which restores the listing + un-suspends the block). DARK backend
   * capability — no UI wiring yet (the mgmt-table Reset button is a downstream PR).
   * Same input shape + posture as the offsite reset; typed failures map via
   * `mapOffsiteError` (NOT_FOUND→NOT_FOUND, NOT_TRANSITIONABLE→BAD_REQUEST).
   */
  resetOnsiteListingToPending: moderatorProcedure
    .input(resetListingToPendingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Resetting on-site listings is restricted to civitai team');
      }
      const { resetOnsiteListingToPending } = await import(
        '~/server/services/blocks/offsite-moderation.service'
      );
      try {
        return await resetOnsiteListingToPending({ input, reviewerUserId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * OWNER unpublish their OWN approved off-site listing (approved → removed) — a
   * self-service visibility toggle (no re-review). Owner-bound in the service
   * (NOT_OWNED→FORBIDDEN); NOT_TRANSITIONABLE when not approved. Typed failures map
   * via `mapOffsiteError`.
   */
  unpublishOwnListing: appDeveloperProcedure
    .use(
      rateLimit({
        limit: 30,
        period: 3600,
        errorMessage: 'Too many listing changes — slow down.',
      })
    )
    .input(unpublishOwnListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { unpublishOwnListing } = await import(
        '~/server/services/blocks/offsite-moderation.service'
      );
      try {
        return await unpublishOwnListing({ input, userId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * OWNER republish their OWN owner-unpublished off-site listing (removed →
   * approved). 🔴 Allowed ONLY when the listing's most-recent moderation event is an
   * `owner-unpublish` — a listing a MODERATOR removed (delist/purge) is FORBIDDEN to
   * self-restore (the load-bearing safety guard, in the service). Owner-bound. Typed
   * failures map via `mapOffsiteError` (NOT_OWNED/FORBIDDEN→FORBIDDEN,
   * NOT_TRANSITIONABLE→BAD_REQUEST).
   */
  republishOwnListing: appDeveloperProcedure
    .use(
      rateLimit({
        limit: 30,
        period: 3600,
        errorMessage: 'Too many listing changes — slow down.',
      })
    )
    .input(republishOwnListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { republishOwnListing } = await import(
        '~/server/services/blocks/offsite-moderation.service'
      );
      try {
        return await republishOwnListing({ input, userId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * OWNER per-listing moderation history for a listing the caller OWNS (the "why was
   * this hidden / un-approved" view). Owner-bound in the service (NOT_FOUND on a
   * missing listing, NOT_OWNED→FORBIDDEN otherwise); same PII-safe projection as the
   * mod `listModerationEvents`.
   */
  listMyListingModerationEvents: appDeveloperProcedure
    .input(listMyListingModerationEventsSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { listMyListingModerationEvents } = await import(
        '~/server/services/blocks/offsite-moderation.service'
      );
      try {
        return await listMyListingModerationEvents({ input, userId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * MOD: the ALL-STATUS listings management table (W13 post-approval mgmt, P2) —
   * every lifecycle status (draft|pending|approved|rejected|removed), keyset-
   * paginated, optional status/kind/search filters. Read-only `moderatorProcedure`
   * (mirrors the sibling mod-read queues `listPendingRequests`/`listListingReports`
   * — mod-only server-side; the client gates rendering on the app-blocks flag +
   * treats a query error as "render nothing"). The per-row lifecycle ACTIONS reuse
   * the merged Phase 1 procs (resetListingToPending / delist / relist / claim /
   * purge) + the off-site approve/reject review flow.
   */
  listAllListingsForModeration: moderatorProcedure
    .input(listAllListingsForModerationSchema)
    .query(async ({ input }) => {
      const { listAllListingsForModeration } = await import(
        '~/server/services/blocks/app-listing.service'
      );
      return listAllListingsForModeration(input);
    }),

  // -------------------------------------------------------------------------
  // P2a UNIFIED STORE READ PATH (over BOTH kinds) — publicProcedure, DARK.
  //
  // Parallel-run: these serve the unified `/apps` store from `AppListing` and
  // live ALONGSIDE the existing AppBlock-backed `blocks.listAvailable` /
  // `blocks.getAppDetail`. The UI switch + cutover are LATER PRs — this PR wires
  // no UI and does NOT touch the AppBlock read path.
  //
  // EXPOSURE / SECURITY: approved-only, PUBLIC-ALLOWLIST projections only
  // (see app-listing-read.schema DTOs — no trustTier / raw iframe.src / OAuth
  // secrets / owner PII beyond the public creator chip / DB status). No per-user
  // data. Maturity-gated (r/x hidden off a red-capable host). Dark behind the
  // mod-segmented App Blocks flag (empty page / NOT_FOUND when off).
  // -------------------------------------------------------------------------

  /** Unified store listing over BOTH kinds — approved rows, keyset-paginated. */
  listAvailable: publicProcedure
    .use(enforceAppListingsReadFlag)
    .use(
      rateLimit({
        limit: 60,
        period: 60,
        errorMessage: 'Too many marketplace requests — slow down.',
      })
    )
    .input(listAppListingsSchema)
    .query(async ({ ctx, input }) => {
      const scope = applyStoreScope(ctx, 'trpc-list');
      if (scope === 'none') {
        return { items: [], nextCursor: undefined };
      }
      const { listAvailableListings } = await import(
        '~/server/services/blocks/app-listing.service'
      );
      return listAvailableListings(input, { redCapable: isRedCapableRequest(ctx), scope });
    }),

  /** Per-listing public detail, by EXACTLY ONE of slug or id (approved only). */
  getAppDetail: publicProcedure
    .use(enforceAppListingsReadFlag)
    .use(
      rateLimit({
        limit: 60,
        period: 60,
        errorMessage: 'Too many marketplace requests — slow down.',
      })
    )
    .input(getAppListingDetailSchema)
    .query(async ({ ctx, input }) => {
      const scope = applyStoreScope(ctx, 'trpc-detail');
      if (scope === 'none') {
        throw throwNotFoundError('Listing not found');
      }
      const { getListingDetail } = await import('~/server/services/blocks/app-listing.service');
      const detail = await getListingDetail(input, { redCapable: isRedCapableRequest(ctx), scope });
      if (!detail) throw throwNotFoundError('Listing not found');
      return detail;
    }),

  // -------------------------------------------------------------------------
  // REVIEW (thumbs/recommend) WRITE + READ — the write half of AppListingReview
  // (the model + the "N% recommend (M)" DISPLAY already existed; only the write
  // path + read procs + the SYNCHRONOUS metric feed were missing).
  //
  // ELIGIBILITY (locked W13 decision, enforced in the service): any signed-in
  // user EXCEPT the listing owner, for BOTH kinds, NO install/usage gate.
  //
  // SCOPE GATING: the WRITEs (`upsertReview`/`getMyReview`) are `protectedProcedure`
  // (auth REQUIRED) + `enforceAppListingsWriteFlag`, which resolves the SAME
  // `StoreVisibilityScope` the read path uses and THROWS UNAUTHORIZED only on
  // `none` (a real anon/non-store caller can't write). Each proc then threads its
  // scope into the service, which applies the shared KIND rule
  // (`scopeAdmitsListingKind`) — so a `public-external` viewer may review an
  // OFFSITE listing (all their scope shows them) and NOT an onsite one, exactly
  // matching `listReviews`'s data-layer kind filter. `listReviews` is
  // `publicProcedure` + `enforceAppListingsReadFlag` (empty page when off, same
  // posture as listAvailable).
  //
  // Zero change for mods + app-dev-testers: they resolve `full`, which admits
  // every kind. The change is that the external-only cohort
  // (`app-listings-public-external`) can now submit the reviews the store already
  // let them see — the gate's own header has the history.
  //
  // MOD control (`setReviewExclude`, below): the deferred per-review exclude path,
  // now built. `listReviews` ALREADY filters `exclude`/`tosViolation`, so the mod
  // action takes effect on the visible list with no read-path change. The report
  // half is still deferred.
  // -------------------------------------------------------------------------

  /**
   * USER: create-or-update the caller's review for a listing (thumbs/recommend),
   * feeding the recommend metric SYNCHRONOUSLY in the same tx. Self-review /
   * non-approved-listing gates are enforced in the service (FORBIDDEN / BAD_REQUEST),
   * as is the STORE-SCOPE kind gate: a `public-external` caller writing to an ONSITE
   * listing gets the same NOT_FOUND the read path gives them, never a distinguishable
   * refusal (the listing is not merely un-writable to them, it is invisible).
   */
  upsertReview: protectedProcedure
    .use(enforceAppListingsWriteFlag)
    .use(
      rateLimit({
        limit: 30,
        period: 60,
        errorMessage: 'Too many review submissions — slow down.',
      })
    )
    .input(upsertAppListingReviewSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const scope = applyStoreScope(ctx, 'trpc-review-write');
      const { upsertAppListingReview } = await import(
        '~/server/services/blocks/app-listing-review.service'
      );
      return upsertAppListingReview({ userId: ctx.user.id, input, scope });
    }),

  /**
   * USER: the caller's OWN review for a listing (form prefill), or null.
   *
   * Soft-fails on the kind gate (returns `null`, like `listReviews` returns an empty
   * page) rather than throwing — this is a read, and a prefill for a listing the
   * caller's scope hides is simply absent.
   */
  getMyReview: protectedProcedure
    .use(enforceAppListingsWriteFlag)
    .input(getMyAppListingReviewSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user) return null;
      const scope = applyStoreScope(ctx, 'trpc-my-review');
      const { getMyAppListingReview } = await import(
        '~/server/services/blocks/app-listing-review.service'
      );
      return getMyAppListingReview(input.appListingId, ctx.user.id, { scope });
    }),

  /** PUBLIC: keyset-paginated reviews for a listing (newest-first, mod-filtered). */
  listReviews: publicProcedure
    .use(enforceAppListingsReadFlag)
    .use(
      rateLimit({
        limit: 60,
        period: 60,
        errorMessage: 'Too many review requests — slow down.',
      })
    )
    .input(listAppListingReviewsSchema)
    .query(async ({ ctx, input }) => {
      const scope = applyStoreScope(ctx, 'trpc-reviews');
      if (scope === 'none') {
        return { items: [], nextCursor: undefined };
      }
      const { listAppListingReviews } = await import(
        '~/server/services/blocks/app-listing-review.service'
      );
      return listAppListingReviews(input, { scope });
    }),

  /**
   * MOD: hide / un-hide a single review (`AppListingReview.exclude`) and move the
   * denormalized recommend counters to match, in one tx.
   *
   * Gate: `moderatorProcedure` + the inner `isModerator` recheck — the SAME idiom
   * as the delist/relist/claim/purge actions above, and the WHOLE trust boundary.
   * Deliberately NOT `enforceAppListingsWriteFlag`: that flag darkens the store UI
   * and mods bypass it anyway, so it would be inert here (matching the mod-action
   * block's own reasoning).
   *
   * NOT a delete. A hard delete would leave the denormalized aggregate permanently
   * wrong, and would let the same user file a fresh FIRST review for the listing —
   * see `setAppListingReviewExclude`'s header for the full reasoning.
   *
   * `exclude` is an explicit target state, so the mutation is IDEMPOTENT: re-hiding
   * an already-hidden review writes nothing and moves no counter. Returns
   * `changed:false` in that case rather than erroring.
   */
  setReviewExclude: moderatorProcedure
    .input(setAppListingReviewExcludeSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Moderating app reviews is restricted to civitai team');
      }
      const { setAppListingReviewExclude } = await import(
        '~/server/services/blocks/app-listing-review.service'
      );
      return setAppListingReviewExclude(input);
    }),
});
