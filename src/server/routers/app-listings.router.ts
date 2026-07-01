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
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import {
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import { isHostForColor } from '~/server/utils/server-domain';

/**
 * App Store Listings (W13) — P1 asset pipeline router (NEW router, locked
 * decision §5.1 — NOT an extension of `blocks.router`). All procs are DARK and
 * additive: owner-scoped (mod override) creator asset management + a mod-only
 * placeholder backfill. Nothing here is on a public read path (that is P2) or a
 * live approval gate (P3).
 *
 * Flag gate: reuses the mod-segmented `app-blocks-enabled` flag (evaluated WITH
 * the request user's context, like blocks.router's `enforceAppBlocksFlag`), so
 * P1 ships dark-to-non-mods and immediately usable by the civitai team. A
 * dedicated `app-listings-enabled` flag lands with the P2 read path when there
 * is a user-facing surface to widen independently.
 */
const enforceAppBlocksFlag = middleware(async ({ ctx, next }) => {
  if (await isAppBlocksEnabled({ user: ctx.user })) return next();
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'App Blocks not enabled' });
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

export const appListingsRouter = router({
  /** Owner/mod read of a listing's current assets (creator dashboard). */
  getAssets: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(listingAssetsQuerySchema)
    .query(async ({ ctx, input }) => {
      const { getListingAssets } = await import('~/server/services/blocks/app-listing-assets.service');
      return getListingAssets({ listingId: input.listingId }, ctx.user);
    }),

  setIcon: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(setListingIconSchema)
    .mutation(async ({ ctx, input }) => {
      const { setListingIcon } = await import('~/server/services/blocks/app-listing-assets.service');
      return setListingIcon(input, ctx.user);
    }),

  setCover: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(setListingCoverSchema)
    .mutation(async ({ ctx, input }) => {
      const { setListingCover } = await import('~/server/services/blocks/app-listing-assets.service');
      return setListingCover(input, ctx.user);
    }),

  addScreenshot: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(addListingScreenshotSchema)
    .mutation(async ({ ctx, input }) => {
      const { addListingScreenshot } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return addListingScreenshot(input, ctx.user);
    }),

  reorderScreenshots: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(reorderListingScreenshotsSchema)
    .mutation(async ({ ctx, input }) => {
      const { reorderListingScreenshots } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return reorderListingScreenshots(input, ctx.user);
    }),

  updateScreenshotCaption: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(updateListingScreenshotCaptionSchema)
    .mutation(async ({ ctx, input }) => {
      const { updateListingScreenshotCaption } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      return updateListingScreenshotCaption(input, ctx.user);
    }),

  removeScreenshot: protectedProcedure
    .use(enforceAppBlocksFlag)
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
