import { TRPCError } from '@trpc/server';

import {
  addListingScreenshotSchema,
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
  upsertAppListingReviewSchema,
} from '~/server/schema/blocks/app-listing-review.schema';
import {
  approveExternalRequestSchema,
  beginListingRevisionSchema,
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
import { rateLimit } from '~/server/middleware.trpc';
import {
  isAppBlocksAuthorEnabled,
  isAppBlocksEnabled,
  isAppListingsEnabled,
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
 * Flag gate for the P2a PUBLIC READ procs (unified store). Anon-CAPABLE but DARK
 * until launch: for a real anon / non-mod viewer the flag never matches → mark
 * `_appBlocksDisabled` so the query returns an EMPTY page / NOT_FOUND (never an
 * error, mirroring `blocks.router`'s read gate) rather than throwing.
 *
 * W13 (PR-W1a / D8): repointed onto the DEDICATED store-visibility flag
 * `isAppListingsEnabled` — which itself OR-falls-back to `isAppBlocksEnabled`, so
 * the currently-visible cohort (mods + app-dev-testers via `app-blocks-enabled`)
 * is UNCHANGED today while the `app-listings` flag does not yet exist. A future
 * true-public flip widens ONLY `app-listings` (this store read path) WITHOUT
 * touching the held block-runtime gate. The AUTHOR gate
 * (`enforceAppBlocksAuthorFlag`) + the mod-only backfill (`enforceAppBlocksFlag`)
 * intentionally stay on their existing flags.
 */
const enforceAppListingsReadFlag = middleware(async ({ ctx, next }) => {
  if (await isAppListingsEnabled({ user: ctx.user })) return next();
  return next({ ctx: { _appBlocksDisabled: true } });
});

/**
 * Store WRITE gate — mirrors `enforceAppBlocksFlag`'s HARD-THROW shape (a write
 * with the store dark must REJECT, not soft-fail like the read gate) but keyed on
 * the DEDICATED store-visibility flag `isAppListingsEnabled` (which OR-falls-back
 * to `isAppBlocksEnabled`). This keeps the review WRITEs (`upsertReview`/
 * `getMyReview`) on the SAME flag as the store visibility + reviews read path
 * (`enforceAppListingsReadFlag`), so once `app-listings` widens independently of
 * the held block-runtime gate, a viewer who can SEE the review affordance can
 * also submit — instead of seeing the button and 403-ing on write. Zero change
 * today: the OR-fallback preserves the existing mods + app-dev-testers cohort.
 */
const enforceAppListingsWriteFlag = middleware(async ({ ctx, next }) => {
  if (await isAppListingsEnabled({ user: ctx.user })) return next();
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
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
    (err.name === 'OffsiteRequestError' || err.name === 'OffsiteModerationError') &&
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
        : 'BAD_REQUEST';
    return new TRPCError({ code: trpcCode, message: err.message });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred while processing the request. Please try again later.',
    cause: err,
  });
}

export const appListingsRouter = router({
  /** Owner/mod read of a listing's current assets (creator dashboard). */
  getAssets: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(listingAssetsQuerySchema)
    .query(async ({ ctx, input }) => {
      const { getListingAssets } = await import('~/server/services/blocks/app-listing-assets.service');
      return getListingAssets({ listingId: input.listingId }, ctx.user);
    }),

  setIcon: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(setListingIconSchema)
    .mutation(async ({ ctx, input }) => {
      const { setListingIcon } = await import('~/server/services/blocks/app-listing-assets.service');
      return setListingIcon(input, ctx.user);
    }),

  setCover: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(setListingCoverSchema)
    .mutation(async ({ ctx, input }) => {
      const { setListingCover } = await import('~/server/services/blocks/app-listing-assets.service');
      return setListingCover(input, ctx.user);
    }),

  addScreenshot: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(addListingScreenshotSchema)
    .mutation(async ({ ctx, input }) => {
      const { addListingScreenshot } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return addListingScreenshot(input, ctx.user);
    }),

  reorderScreenshots: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(reorderListingScreenshotsSchema)
    .mutation(async ({ ctx, input }) => {
      const { reorderListingScreenshots } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return reorderListingScreenshots(input, ctx.user);
    }),

  updateScreenshotCaption: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(updateListingScreenshotCaptionSchema)
    .mutation(async ({ ctx, input }) => {
      const { updateListingScreenshotCaption } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return updateListingScreenshotCaption(input, ctx.user);
    }),

  removeScreenshot: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(removeListingScreenshotSchema)
    .mutation(async ({ ctx, input }) => {
      const { removeListingScreenshot } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return removeListingScreenshot(input, ctx.user);
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
      return submitExternalListing({ input, userId: ctx.user.id });
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
      try {
        await withdrawExternalRequest({
          publishRequestId: input.publishRequestId,
          userId: ctx.user.id,
        });
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      return { ok: true };
    }),

  /**
   * AUTHOR: edit an existing off-site listing WITHOUT withdrawing it (state-aware).
   * draft/pending → in place; approved-trivial (tagline/description/category/
   * contentRating) → in place; approved-material (externalUrl/name) → staged on a
   * shadow-draft revision (`requiresReview:true` + the `shadowId` to edit assets
   * against, then `submitListingRevision`). Owner-bound in the service. Rejected →
   * MUST_RESUBMIT; removed → FORBIDDEN. Typed failures map via `mapOffsiteError`.
   */
  updateListing: appDeveloperProcedure
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
   * MUST_RESUBMIT/BAD_REQUEST, removed→FORBIDDEN). Typed failures via `mapOffsiteError`.
   */
  getMyListingForEdit: appDeveloperProcedure
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
   */
  updateRevisionDraft: appDeveloperProcedure
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
   * listing, enforces `assertListingAssetsComplete` (THE P3 activation — approve
   * FAILS unless icon+cover+≥1 screenshot) + re-validates the stored externalUrl,
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
        throw throwAuthorizationError('Approving off-site listings is restricted to civitai team');
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
        throw throwAuthorizationError('Rejecting off-site listings is restricted to civitai team');
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
      const { reportListing } = await import(
        '~/server/services/blocks/offsite-moderation.service'
      );
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
  delistListing: moderatorProcedure
    .input(delistListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Delisting off-site listings is restricted to civitai team');
      }
      const { delistListing } = await import('~/server/services/blocks/offsite-moderation.service');
      try {
        return await delistListing({ input, reviewerUserId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /** MOD relist a removed off-site listing (removed → approved). Reversibility. */
  relistListing: moderatorProcedure
    .input(relistListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Relisting off-site listings is restricted to civitai team');
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
  claimListing: moderatorProcedure
    .input(claimListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError(
          'Reassigning off-site listings is restricted to civitai team'
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
   * MOD hard-delete (purge) an off-site listing — the final expunge + the
   * self-clean primitive. Writes the audit event BEFORE the delete so the event row
   * survives at the ROW level for audit/compliance (SetNull FK + slug snapshot). It
   * is NOT retrievable via the per-listing history read (`listModerationEvents`)
   * once purged — the FK is nulled, so post-purge it's reachable only via the actor
   * index / raw SQL (a slug-keyed orphaned-events read path is deferred to pre-GA).
   * Destructive — the UI gates it behind a confirm.
   */
  purgeListing: moderatorProcedure
    .input(purgeListingSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Purging off-site listings is restricted to civitai team');
      }
      const { purgeListing } = await import('~/server/services/blocks/offsite-moderation.service');
      try {
        return await purgeListing({ input, reviewerUserId: ctx.user.id });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /** MOD resolve a pending report (pending → resolved) + audit event. */
  resolveReport: moderatorProcedure
    .input(resolveReportSchema)
    .mutation(async ({ ctx, input }) => {
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
  dismissReport: moderatorProcedure
    .input(dismissReportSchema)
    .mutation(async ({ ctx, input }) => {
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
        throw throwAuthorizationError('Resetting off-site listings is restricted to civitai team');
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
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { items: [], nextCursor: undefined };
      }
      const { listAvailableListings } = await import(
        '~/server/services/blocks/app-listing.service'
      );
      return listAvailableListings(input, { redCapable: isRedCapableRequest(ctx) });
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
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        throw throwNotFoundError('Listing not found');
      }
      const { getListingDetail } = await import('~/server/services/blocks/app-listing.service');
      const detail = await getListingDetail(input, { redCapable: isRedCapableRequest(ctx) });
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
  // FLAG GATING: the WRITEs (`upsertReview`/`getMyReview`) are `protectedProcedure`
  // (auth REQUIRED) + `enforceAppListingsWriteFlag` — the "store enabled for this
  // viewer" gate keyed on the SAME dedicated `app-listings` flag as the store
  // visibility + `listReviews` read path, THROWING UNAUTHORIZED when off (a real
  // anon/non-store caller can't write). Keeping the writes on `app-listings`
  // (not the held block-runtime `app-blocks-enabled`) means the review submit
  // widens WITH the store, so a viewer who SEES the affordance can also submit
  // instead of 403-ing. `listReviews` is `publicProcedure` +
  // `enforceAppListingsReadFlag` (empty page when off, same posture as
  // listAvailable). Zero change today: `isAppListingsEnabled` OR-falls-back to
  // `isAppBlocksEnabled`, so the current mods + app-dev-testers cohort is
  // unchanged. The review affordance renders only on the mod-only store-preview
  // surface today (the public `/apps/[slug]` cutover is P2d).
  //
  // FOLLOW-UP (deferred): a MOD exclude/report path for individual reviews.
  // `listReviews` ALREADY filters `exclude`/`tosViolation`, so a future mod action
  // takes effect on the visible list with no read-path change.
  // -------------------------------------------------------------------------

  /**
   * USER: create-or-update the caller's review for a listing (thumbs/recommend),
   * feeding the recommend metric SYNCHRONOUSLY in the same tx. Self-review /
   * non-approved-listing gates are enforced in the service (FORBIDDEN / BAD_REQUEST).
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
      const { upsertAppListingReview } = await import(
        '~/server/services/blocks/app-listing-review.service'
      );
      return upsertAppListingReview({ userId: ctx.user.id, input });
    }),

  /** USER: the caller's OWN review for a listing (form prefill), or null. */
  getMyReview: protectedProcedure
    .use(enforceAppListingsWriteFlag)
    .input(getMyAppListingReviewSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user) return null;
      const { getMyAppListingReview } = await import(
        '~/server/services/blocks/app-listing-review.service'
      );
      return getMyAppListingReview(input.appListingId, ctx.user.id);
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
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { items: [], nextCursor: undefined };
      }
      const { listAppListingReviews } = await import(
        '~/server/services/blocks/app-listing-review.service'
      );
      return listAppListingReviews(input);
    }),
});
