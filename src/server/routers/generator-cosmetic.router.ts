import {
  gateGeneratorCosmeticImageSchema,
  persistGeneratorCosmeticImageSchema,
} from '~/server/schema/blocks/generator-cosmetic-image.schema';
import { rateLimit } from '~/server/middleware.trpc';
import { protectedProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

/**
 * Custom Generators (Phase-2a PR-C) — the SESSION-AUTHED cosmetic-background image
 * upload bridge behind the page host's `OPEN_IMAGE_UPLOAD` handler. The bytes flow
 * through civitai's OWN authenticated upload path (the block iframe never sees
 * them), so these are `protectedProcedure` (the logged-in builder), NOT block-JWT
 * routes and NOT a new block scope.
 *
 *   - persistImage — materialise the CF upload into a scannable `Image` (real
 *     `createImage` + `ingestImage`, NO trust-stamp).
 *   - gateImage    — poll the scan; return the moderated id ONLY once scanned-clean
 *     AND within the SFW ceiling (else throw). See the service + pure classifier.
 */
export const generatorCosmeticRouter = router({
  persistImage: protectedProcedure
    .use(
      rateLimit({
        limit: 60,
        period: 3600,
        errorMessage: 'Too many image uploads — slow down.',
      })
    )
    .input(persistGeneratorCosmeticImageSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { persistGeneratorCosmeticImage } = await import(
        '~/server/services/blocks/generator-cosmetic-image.service'
      );
      return persistGeneratorCosmeticImage({ input, userId: ctx.user.id });
    }),

  gateImage: protectedProcedure
    .input(gateGeneratorCosmeticImageSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { gateGeneratorCosmeticImage } = await import(
        '~/server/services/blocks/generator-cosmetic-image.service'
      );
      return gateGeneratorCosmeticImage({ imageId: input.imageId, user: ctx.user });
    }),
});
