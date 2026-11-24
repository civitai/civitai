import {
  getMyStickerHats,
  getReactionEarns,
  getTurfStickers,
  getTurfStickersForImages,
  getTurfStock,
  getFlagRaceEventForCollection,
  getFlagSummary,
  getFlagRaceTotals,
  getPastFlags,
  getOpenFlagCrucible,
  getTurfSummaries,
  placeFlagHats,
  placeTurfSticker,
  removeTurfSticker,
  setTurfOptIn,
  setTurfOwnerOff,
  watchTurfImages,
} from '~/server/events/turf/turf.service';
import { edgeCacheIt, rateLimit } from '~/server/middleware.trpc';
import type { Context } from '~/server/createContext';
import { CacheTTL } from '~/server/common/constants';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import {
  placeFlagHatsSchema,
  placeTurfStickerSchema,
  removeTurfStickerSchema,
  setTurfOptInSchema,
  setTurfOwnerOffSchema,
  turfEventSchema,
  flagRaceCollectionSchema,
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

const WATCH_RATE_LIMIT = { limit: 60, period: 60 };

/**
 * A summaries read standing in for a `hatTurf.watch` call: the same marks, drawn from the same
 * per-caller bucket, so folding the marks into the read never lets a caller mark more often. Never
 * fails the read: a refusal or a store error marks nothing and answers false, and the page then
 * sends its own mark. True only when every asked image was marked (none refused at the set's cap),
 * since the page skips its own mark only for those.
 */
async function markReadWatched(
  ctx: Pick<Context, 'user' | 'req'>,
  input: { event: string; imageIds: number[] }
) {
  try {
    const record = await claimRateLimitAttempt({
      rules: [WATCH_RATE_LIMIT],
      keyName: 'hatTurf:watch',
      scope: 'hatTurf.getSummaries',
      user: ctx.user,
      req: ctx.req,
    });
    const asked = new Set(input.imageIds).size;
    const marked = await watchTurfImages(input.event, input.imageIds, { limit: asked });
    await record();
    return asked > 0 && marked === asked;
  } catch {
    return false;
  }
}

// Hat Turf: team hat stickers on other people's images (events/turf).
export const hatTurfRouter = router({
  // The viewer's sticker supply: available now and the rate and cap in force (future steps stay unpublished).
  getStock: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfEventSchema)
    .query(({ ctx, input }) => getTurfStock(input.event, ctx.user.id)),
  // Per-image team counts and leader for a page of feed cards, plus the viewer's team. With `watch`,
  // a joined viewer's read also marks the images watched (markReadWatched); only a joined viewer
  // hears the pushes, so nobody else's read fills the interest set.
  getSummaries: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(turfSummariesSchema)
    .query(async ({ ctx, input }) => {
      const summaries = await getTurfSummaries(input.event, input.imageIds, ctx.user?.id);
      const watched =
        !!input.watch && !!ctx.user && summaries.joined ? await markReadWatched(ctx, input) : false;
      return { ...summaries, watched };
    }),
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
  // re-marked while in view; no Postgres on this path.
  watch: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(watchTurfImagesSchema)
    .use(rateLimit(WATCH_RATE_LIMIT))
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
  // Each team's flags won and points across the frozen days, for the event page's Flag Race.
  getFlagRaceTotals: publicProcedure
    .input(turfEventSchema)
    .use(edgeCacheIt({ ttl: 60 }))
    .query(({ input }) => getFlagRaceTotals(input.event)),
  // Past days' frozen flags, for their badges on the all-time collection and image detail.
  getPastFlags: publicProcedure
    .input(turfEventSchema)
    .use(edgeCacheIt({ ttl: 300 }))
    .query(({ input }) => getPastFlags(input.event)),
  // The flag Crucible taking entries now, for the row's "Enter the race" button.
  getOpenFlagCrucible: publicProcedure
    .input(turfEventSchema)
    .use(edgeCacheIt({ ttl: 30 }))
    .query(({ input }) => getOpenFlagCrucible(input.event)),
  // Which event's Flag Race a Collection holds, so its page can show the flags' badges.
  getFlagRaceForCollection: publicProcedure
    .input(flagRaceCollectionSchema)
    .use(edgeCacheIt({ ttl: 60 }))
    .query(({ input }) => getFlagRaceEventForCollection(input.collectionId)),
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
