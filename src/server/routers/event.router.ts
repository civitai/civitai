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
  getEventAccess,
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
} from '~/server/services/event.service';
import { middleware, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// A previewer sees an event the public cannot yet, so their responses must never be cached (edge or
// Redis) where the public could be served them.
const noCacheInPreview = middleware(async ({ ctx, input, next }) => {
  const { event } = input as EventInput;
  if (!ctx.cache || (await getEventAccess({ event, viewer: ctx.user })) !== 'preview')
    return next();
  return next({ ctx: { cache: { ...ctx.cache, skip: true, canCache: false } } });
});

export const eventRouter = router({
  // What the viewer may do with an event: closed, preview, open or ended. Per viewer, so uncached.
  getAccess: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getEventAccess({ ...input, viewer: ctx.user })),
  getData: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(noCacheInPreview)
    // .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ ctx, input }) => getEventData({ ...input, viewer: ctx.user })),
  getTeamScores: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(noCacheInPreview)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ ctx, input }) => getTeamScores({ ...input, viewer: ctx.user })),
  getTeamScoreHistory: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(teamScoreHistorySchema)
    .use(noCacheInPreview)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ ctx, input }) => getTeamScoreHistory({ ...input, viewer: ctx.user })),
  getCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getEventCosmetic({ user: ctx.user, ...input })),
  getPartners: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(noCacheInPreview)
    .use(edgeCacheIt({ ttl: CacheTTL.day }))
    .query(({ ctx, input }) => getEventPartners({ ...input, viewer: ctx.user })),
  getRewards: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(noCacheInPreview)
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
    .use(noCacheInPreview)
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
    .use(noCacheInPreview)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ ctx, input }) => getEventStandings({ ...input, viewer: ctx.user })),
  getMyCosmeticScores: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getMyEventCosmeticScores({ user: ctx.user, ...input })),
  getCosmeticScores: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventCosmeticScoresSchema)
    .use(noCacheInPreview)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ ctx, input }) => getEventCosmeticScores({ ...input, viewer: ctx.user })),
  getUserRank: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getUserRank({ user: ctx.user, ...input })),
});
