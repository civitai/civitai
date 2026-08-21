import {
  getStickerBookSchema,
  getStickerBookSectionSchema,
} from '~/server/schema/sticker-book.schema';
import { getStickerBook, getStickerBookSection } from '~/server/services/sticker-book.service';
import { publicProcedure, router } from '~/server/trpc';

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
      browsingLevel: input.browsingLevel,
      user: ctx.user ?? undefined,
      isModerator: !!ctx.user?.isModerator,
    })
  ),

  /**
   * One section, paged — the "View all" behind each row on the tab.
   *
   * Re-asks the visibility question rather than trusting that the tab rendered:
   * this is a URL of its own, and a hidden book has to refuse it here too.
   */
  getSection: publicProcedure.input(getStickerBookSectionSchema).query(({ input, ctx }) =>
    getStickerBookSection({
      username: input.username,
      side: input.side,
      page: input.page,
      browsingLevel: input.browsingLevel,
      user: ctx.user ?? undefined,
      isModerator: !!ctx.user?.isModerator,
    })
  ),
});
