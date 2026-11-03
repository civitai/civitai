import {
  getMyStickerHats,
  getTurfStickers,
  getTurfStock,
  getTurfSummaries,
  placeTurfSticker,
  removeTurfSticker,
  setTurfOptIn,
} from '~/server/events/turf/turf.service';
import { rateLimit } from '~/server/middleware.trpc';
import {
  placeTurfStickerSchema,
  removeTurfStickerSchema,
  setTurfOptInSchema,
  turfEventSchema,
  turfImageSchema,
  turfSummariesSchema,
} from '~/server/schema/turf.schema';
import {
  guardedProcedure,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Hat Turf: team hat stickers on other people's images (events/turf).
export const hatTurfRouter = router({
  // The viewer's sticker supply: available now and the rate and cap in force (future steps stay unpublished).
  getStock: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfEventSchema)
    .query(({ ctx, input }) => getTurfStock(input.event, ctx.user.id)),
  // Per-image team counts and leader for a page of feed cards, plus the viewer's team.
  getSummaries: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfSummariesSchema)
    .query(({ ctx, input }) => getTurfSummaries(input.event, input.imageIds, ctx.user?.id)),
  // One image's stickers to draw, capped, plus the viewer's own.
  getImageStickers: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfImageSchema)
    .query(({ ctx, input }) => getTurfStickers(input.event, input.imageId, ctx.user?.id)),
  // The player's event hats to use as sticker art, with last-used and use counts.
  getMyStickerHats: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfEventSchema)
    .query(({ ctx, input }) => getMyStickerHats(input.event, ctx.user.id)),
  // guarded: a muted account must not put anything on someone else's image.
  place: guardedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(placeTurfStickerSchema)
    .use(rateLimit({ limit: 60, period: 60 }))
    .mutation(({ ctx, input }) => placeTurfSticker({ ...input, userId: ctx.user.id })),
  setOptIn: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setTurfOptInSchema)
    .use(rateLimit({ limit: 20, period: 60 }))
    .mutation(({ ctx, input }) => setTurfOptIn(input.event, ctx.user.id, input.optedIn)),
  remove: moderatorProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(removeTurfStickerSchema)
    .mutation(({ ctx, input }) => removeTurfSticker(input.id, ctx.user.id)),
});
