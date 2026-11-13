import {
  getMyStickerHats,
  getReactionEarns,
  getTurfStickers,
  getTurfStickersForImages,
  getTurfStock,
  getFlagSummary,
  getTurfSummaries,
  placeFlagHats,
  placeTurfSticker,
  removeTurfSticker,
  setTurfOptIn,
  setTurfOwnerOff,
  watchTurfImages,
} from '~/server/events/turf/turf.service';
import { edgeCacheIt, rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import {
  placeFlagHatsSchema,
  placeTurfStickerSchema,
  removeTurfStickerSchema,
  setTurfOptInSchema,
  setTurfOwnerOffSchema,
  turfEventSchema,
  turfImageSchema,
  turfReactionEarnsSchema,
  turfStickersForImagesSchema,
  turfSummariesSchema,
  watchTurfImagesSchema,
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
  // One image's stickers to draw, a page at a time, plus the viewer's own.
  getImageStickers: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfImageSchema)
    .query(({ ctx, input }) =>
      getTurfStickers(input.event, input.imageId, ctx.user?.id, input.before)
    ),
  // Stickers to draw on a page of feed cards, a few per image.
  getStickersForImages: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfStickersForImagesSchema)
    .use(rateLimit({ limit: 60, period: 60 }))
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input }) => getTurfStickersForImages(input.event, input.imageIds, input.perImage)),
  // Marks images as on screen so their count changes are pushed (turf-watch.ts). Called on view and
  // every 30s while in view; no Postgres on this path.
  watch: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(watchTurfImagesSchema)
    .use(rateLimit({ limit: 60, period: 60 }))
    .mutation(({ input }) => watchTurfImages(input.event, input.imageIds)),
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
  // Hats on one of today's flags, 1, 5 or 10 at a time. guarded, as place.
  placeFlagHats: guardedProcedure
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(placeFlagHatsSchema)
    .use(rateLimit({ limit: 60, period: 60 }))
    .mutation(({ ctx, input }) =>
      placeFlagHats({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  // Today's flags and their live counts for the home row. The same for every viewer.
  getFlags: publicProcedure
    .input(turfEventSchema)
    .use(edgeCacheIt({ ttl: 10 }))
    .query(({ input }) => getFlagSummary(input.event)),
  // Whether the viewer reacting to an image would pay their team: asked for the reaction nudge after a
  // placement, so the placement itself never waits on it.
  reactionEarns: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfReactionEarnsSchema)
    .use(rateLimit({ limit: 60, period: 60 }))
    .query(({ ctx, input }) => getReactionEarns({ ...input, userId: ctx.user.id })),
  setOptIn: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setTurfOptInSchema)
    .use(rateLimit({ limit: 20, period: 60 }))
    .mutation(async ({ ctx, input }) => {
      const result = await setTurfOptIn(input.event, ctx.user.id, input.optedIn);
      // Server-side only, and only on a real change, so a repeated toggle is counted once and the
      // browser cannot forge a join (the browser schema refuses opt_in / opt_out).
      if (result.changed)
        ctx.track.action(
          {
            type: 'HatTurf_Action',
            details: { action: input.optedIn ? 'opt_in' : 'opt_out', event: result.event },
          },
          { skipActorMeta: true }
        );
      return result;
    }),
  // The owner's "keep Hat Turf off my images"; refused while the user is in Hat Turf.
  setOwnerOff: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setTurfOwnerOffSchema)
    .use(rateLimit({ limit: 20, period: 60 }))
    .mutation(({ ctx, input }) => setTurfOwnerOff(input.event, ctx.user.id, input.off)),
  remove: moderatorProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(removeTurfStickerSchema)
    .mutation(({ ctx, input }) => removeTurfSticker(input.id, ctx.user.id)),
});
