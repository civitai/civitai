import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { cacheIt, edgeCacheIt } from '~/server/middleware.trpc';
import type { EventInput } from '~/server/schema/event.schema';
import {
  eventCosmeticScoresSchema,
  eventSchema,
  teamScoreHistorySchema,
} from '~/server/schema/event.schema';
import {
  activateEventCosmetic,
  donate,
  getViewerEventAccess,
  getEventCosmetic,
  getEventData,
  getEventRewards,
  getTeamScoreHistory,
  getTeamScores,
  getEventContributors,
  getUserRank,
  getEventPartners,
  getEventStandings,
  getMyEventCosmeticScores,
  getEventCosmeticScores,
  getEventHatCatalog,
  getMyEventHats,
  getPlaceableEventContent,
} from '~/server/services/event.service';
import { middleware, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Reads an event the viewer cannot see as an unknown one, ahead of any cache: a cached response
// must never answer for the gate. A viewer who sees the event differently from a signed-out viewer
// (a tester in the preview, or a moderator while the flag's base is off) gets a response that is
// never cached, at the edge or in Redis, where someone else could be served it.
const eventGate = middleware(async ({ ctx, input, next }) => {
  const { event } = input as EventInput;
  const access = await getViewerEventAccess({ event, viewer: ctx.user });
  if (access === 'closed') throw throwNotFoundError("That event doesn't exist");
  if (!ctx.cache || !ctx.user) return next();
  if ((await getViewerEventAccess({ event, viewer: undefined })) === access) return next();
  return next({ ctx: { cache: { ...ctx.cache, skip: true, canCache: false } } });
});

export const eventRouter = router({
  // What the viewer may do with an event: closed, preview, open or ended. Per viewer, so uncached.
  getAccess: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getViewerEventAccess({ ...input, viewer: ctx.user })),
  getData: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(eventGate)
    // .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ ctx, input }) => getEventData({ ...input, viewer: ctx.user })),
  getTeamScores: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(eventGate)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ ctx, input }) => getTeamScores({ ...input, viewer: ctx.user })),
  getTeamScoreHistory: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(teamScoreHistorySchema)
    .use(eventGate)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ ctx, input }) => getTeamScoreHistory({ ...input, viewer: ctx.user })),
  getCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getEventCosmetic({ user: ctx.user, ...input })),
  getPartners: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(eventGate)
    .use(edgeCacheIt({ ttl: CacheTTL.day }))
    .query(({ ctx, input }) => getEventPartners({ ...input, viewer: ctx.user })),
  getRewards: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(eventGate)
    .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ ctx, input }) => getEventRewards({ ...input, viewer: ctx.user })),
  activateCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(eventSchema)
    .mutation(({ ctx, input }) => activateEventCosmetic({ user: ctx.user, ...input })),
  donate: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialTip, blockApiKeys: true })
    .input(eventSchema.extend({ amount: z.number() }))
    .mutation(({ input, ctx }) => donate({ userId: ctx.user.id, ...input })),
  getDonors: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(eventGate)
    .use(
      cacheIt({
        ttl: CacheTTL.day,
        tags: (input: EventInput) => ['event-donors', `event-donors-${input.event}`],
      })
    )
    .use(
      edgeCacheIt({
        ttl: CacheTTL.xs,
        tags: () => ['event-donors'],
      })
    )
    .query(({ ctx, input }) => getEventContributors({ ...input, viewer: ctx.user })),
  getStandings: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(eventGate)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ ctx, input }) => getEventStandings({ ...input, viewer: ctx.user })),
  getHatCatalog: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(eventGate)
    .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ ctx, input }) => getEventHatCatalog({ ...input, viewer: ctx.user })),
  getMyCosmeticScores: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getMyEventCosmeticScores({ user: ctx.user, ...input })),
  getCosmeticScores: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventCosmeticScoresSchema)
    .use(eventGate)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ ctx, input }) => getEventCosmeticScores({ ...input, viewer: ctx.user })),
  // The caller's own hats and content: per user, so never cached.
  getMyHats: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getMyEventHats({ user: ctx.user, ...input })),
  getPlaceableContent: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getPlaceableEventContent({ user: ctx.user, ...input })),
  getUserRank: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getUserRank({ user: ctx.user, ...input })),
});
