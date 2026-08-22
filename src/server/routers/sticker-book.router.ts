import {
  getStickerBookSchema,
  getStickerBookSectionSchema,
} from '~/server/schema/sticker-book.schema';
import { getStickerBook, getStickerBookSection } from '~/server/services/sticker-book.service';
import type { Context } from '~/server/createContext';
import { publicProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

/**
 * 🔴 THE PROCEDURES ARE GATED, NOT JUST THE TAB.
 *
 * The flag exists to withhold a DISCLOSURE — what a creator owns, what they have
 * stickered, and whose work stickered theirs, on a public profile. A gate on the
 * tab alone leaves that queryable by username for everyone while the creator's
 * only opt-out sits behind the same flag they do not have, so the people whose
 * activity is published are exactly the people who cannot turn it off.
 *
 * The cost, stated: if this flag is ever used as a kill switch rather than a
 * launch gate, a creator loses the record of placements they were paid for until
 * it comes back. That is recoverable; publishing an unlaunched surface is not.
 */
function assertStickerBookEnabled(ctx: Context) {
  if (!ctx.features.stickerBook)
    throw throwAuthorizationError('sticker book: this is not available yet');
}

export const stickerBookRouter = router({
  /**
   * One creator's book. Public, because it is a profile tab — what the viewer
   * may see is decided in the service from the creator's two toggles and the
   * viewer's own standing, and the withheld halves never leave it.
   *
   * Gated on `stickerBook` — see `assertStickerBookEnabled`.
   */
  get: publicProcedure.input(getStickerBookSchema).query(({ input, ctx }) => {
    assertStickerBookEnabled(ctx);
    return getStickerBook({
      username: input.username,
      limit: input.limit,
      browsingLevel: input.browsingLevel,
      user: ctx.user ?? undefined,
      isModerator: !!ctx.user?.isModerator,
    });
  }),

  /**
   * One section, paged — the "View all" behind each row on the tab.
   *
   * Re-asks the visibility question rather than trusting that the tab rendered:
   * this is a URL of its own, and a hidden book has to refuse it here too.
   */
  getSection: publicProcedure.input(getStickerBookSectionSchema).query(({ input, ctx }) => {
    assertStickerBookEnabled(ctx);
    return getStickerBookSection({
      username: input.username,
      side: input.side,
      page: input.page,
      browsingLevel: input.browsingLevel,
      user: ctx.user ?? undefined,
      isModerator: !!ctx.user?.isModerator,
    });
  }),
});
