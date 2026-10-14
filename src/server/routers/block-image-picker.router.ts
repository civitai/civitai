import { getBlockPickablePostedImagesSchema } from '~/server/schema/blocks/block-image-picker.schema';
import { protectedProcedure, router } from '~/server/trpc';
import { getRequestBrowsingLevel } from '~/server/utils/browsing-level';

/**
 * Session-authed data for the page host's `OPEN_IMAGE_PICKER` modal. The modal is host chrome, so
 * these run as the signed-in viewer, not on a block token: the app never calls them and only
 * receives what the viewer picks.
 *
 * The browsing level is read from the session and the request's domain, never from the input, so
 * what is listed cannot be widened by the caller.
 */
export const blockImagePickerRouter = router({
  getPosted: protectedProcedure
    .input(getBlockPickablePostedImagesSchema)
    .query(async ({ ctx, input }) => {
      const { getBlockPickablePostedImages } = await import(
        '~/server/services/blocks/block-image-picker.service'
      );
      return getBlockPickablePostedImages({
        ...input,
        userId: ctx.user.id,
        browsingLevel: getRequestBrowsingLevel(ctx),
      });
    }),
});
