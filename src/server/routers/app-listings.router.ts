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
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { middleware, moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

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
});
