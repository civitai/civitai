import {
  gateBlockUploadImageSchema,
  persistBlockUploadImageSchema,
} from '~/server/schema/blocks/block-image-upload.schema';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { rateLimit } from '~/server/middleware.trpc';
import { protectedProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

/**
 * App Blocks (Phase-2a PR-C) — the SESSION-AUTHED block image-upload bridge behind
 * the page host's `OPEN_IMAGE_UPLOAD` handler. A sandboxed block asks the host to
 * let the user upload an image; the bytes flow through civitai's OWN authenticated
 * upload path (the block iframe never sees them), so these are `protectedProcedure`
 * (the logged-in user), NOT block-JWT routes and NOT a new block scope — a generic
 * peer of `OPEN_RESOURCE_PICKER`.
 *
 *   - persist — materialise the CF upload into a scannable `Image` (real
 *     `createImage` + `ingestImage`, NO trust-stamp).
 *   - gate    — poll the scan; return the moderated id ONLY once scanned-clean,
 *     within the SFW ceiling, and unflagged (else throw). See the service + pure
 *     classifier.
 *   - generationSourceUsesScannedRows — which path a `generationSource` upload takes.
 */
export const blockImageUploadRouter = router({
  persist: protectedProcedure
    .use(
      rateLimit({
        limit: 60,
        period: 3600,
        errorMessage: 'Too many image uploads — slow down.',
      })
    )
    .input(persistBlockUploadImageSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { persistBlockUploadImage } = await import(
        '~/server/services/blocks/block-image-upload.service'
      );
      return persistBlockUploadImage({ input, userId: ctx.user.id });
    }),

  gate: protectedProcedure
    .input(gateBlockUploadImageSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { gateBlockUploadImage } = await import(
        '~/server/services/blocks/block-image-upload.service'
      );
      return gateBlockUploadImage({ imageId: input.imageId, user: ctx.user });
    }),

  /**
   * Whether a PRIVATE generation source the host just uploaded as a consumer blob (the
   * `generationSource` picker, a single `OPEN_MEDIA_UPLOAD` image) must be kept as a scanned row
   * (`blocks.persistUploadedGenerationSource`) before an app can generate from it. It is the flag
   * the generation gate reads to refuse an app's orchestrator urls, evaluated the same way (global,
   * no entity), so the host copies the blob exactly when the gate would refuse it. Off, unknown or
   * unreachable all answer false, as they do for the gate.
   */
  generationSourceUsesScannedRows: protectedProcedure.query(async () => ({
    scannedRows: await isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCK_SOURCE_SCANNED_ROWS),
  })),
});
