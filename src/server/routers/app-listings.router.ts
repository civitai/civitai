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
  listAppListingsSchema,
} from '~/server/schema/blocks/app-listing-read.schema';
import {
  approveExternalRequestSchema,
  listMySubmissionsSchema,
  listOffsiteRequestsSchema,
  persistListingAssetImageSchema,
  rejectExternalRequestSchema,
  submitExternalListingSchema,
  withdrawExternalRequestSchema,
} from '~/server/schema/blocks/offsite-listing.schema';
import { rateLimit } from '~/server/middleware.trpc';
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
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
 *   - `enforceAppListingsReadFlag` (`app-blocks-enabled`) — the DARK public store
 *     read path (empty page / NOT_FOUND until the segment widens at cutover).
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
 * until launch: for a real anon / non-mod viewer the mod-segmented
 * `app-blocks-enabled` flag never matches → mark `_appBlocksDisabled` so the
 * query returns an EMPTY page / NOT_FOUND (never an error, mirroring
 * `blocks.router`'s read gate) rather than throwing. The surface only serves
 * real anon callers once the SEGMENT is widened at launch (a deliberate, separate
 * Flipt change — and, at the read-path cutover, its own `appListings` flag).
 */
const enforceAppListingsReadFlag = middleware(async ({ ctx, next }) => {
  if (await isAppBlocksEnabled({ user: ctx.user })) return next();
  return next({ ctx: { _appBlocksDisabled: true } });
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
 *   - A typed `OffsiteRequestError` maps to its precise TRPC code
 *     (`NOT_FOUND`→NOT_FOUND, `NOT_OWNED`→FORBIDDEN, `NOT_PENDING`/other→
 *     BAD_REQUEST). It is DUCK-TYPED on `name` + `code` so the router never has to
 *     eagerly `import` the service module (services are loaded via dynamic
 *     `import()` to keep the Prisma client out of the router's import graph).
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
    err.name === 'OffsiteRequestError' &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    const code = (err as { code?: unknown }).code as string;
    const trpcCode =
      code === 'NOT_FOUND' ? 'NOT_FOUND' : code === 'NOT_OWNED' ? 'FORBIDDEN' : 'BAD_REQUEST';
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
   * AUTHOR: submit a pure external-link off-site app. Creates a DRAFT
   * `AppListing` + a `pending` `AppListingPublishRequest` (B1); the author then
   * attaches assets via the (author-gated) asset-CRUD procs above before a mod
   * approves it (PR-b). Owner-bound to the caller (no user-supplied owner).
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
        });
      } catch (err) {
        throw mapOffsiteError(err);
      }
    }),

  /**
   * MOD: reject a pending off-site request (PR-b). Requires `rejectionReason` ≥10
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
});
