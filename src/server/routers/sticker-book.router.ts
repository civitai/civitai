import { getStickerBookSchema } from '~/server/schema/sticker-book.schema';
import { getStickerBook } from '~/server/services/sticker-book.service';
import { publicProcedure, router } from '~/server/trpc';
import { domainServableLevels, viewerBrowsingLevel } from '~/server/utils/placement-levels';

export const stickerBookRouter = router({
  /**
   * One creator's book. Public, because it is a profile tab — what the viewer
   * may see is decided in the service from the creator's two toggles and the
   * viewer's own standing, and the withheld halves never leave it.
   *
   * Deliberately NOT flag-gated. The sticker flags decide whether stickers can
   * be bought and placed; this only reports placements that already happened,
   * and a creator who was paid for one should not lose the record of it because
   * the feature was turned back to testers.
   */
  get: publicProcedure.input(getStickerBookSchema).query(({ input, ctx }) =>
    getStickerBook({
      username: input.username,
      limit: input.limit,
      viewerId: ctx.user?.id,
      isModerator: !!ctx.user?.isModerator,
      domainLevels: domainServableLevels(ctx),
      viewerLevels: viewerBrowsingLevel(ctx, input.browsingLevel),
    })
  ),
});
