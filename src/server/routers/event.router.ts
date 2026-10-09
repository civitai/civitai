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
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const eventRouter = router({
  getData: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    // .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ input }) => getEventData(input)),
  getTeamScores: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input }) => getTeamScores(input)),
  getTeamScoreHistory: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(teamScoreHistorySchema)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input }) => getTeamScoreHistory(input)),
  getCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getEventCosmetic({ userId: ctx.user.id, ...input })),
  getPartners: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.day }))
    .query(({ input }) => getEventPartners(input)),
  getRewards: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ input }) => getEventRewards(input)),
  activateCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(eventSchema)
    .mutation(({ ctx, input }) => activateEventCosmetic({ userId: ctx.user.id, ...input })),
  donate: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialTip, blockApiKeys: true })
    .input(eventSchema.extend({ amount: z.number() }))
    .mutation(({ input, ctx }) => donate({ userId: ctx.user.id, ...input })),
  getDonors: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
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
    .query(({ input }) => getEventContributors(input)),
  getStandings: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ input }) => getEventStandings(input)),
  getMyCosmeticScores: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getMyEventCosmeticScores({ userId: ctx.user.id, ...input })),
  getCosmeticScores: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventCosmeticScoresSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(({ input }) => getEventCosmeticScores(input)),
  getUserRank: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(eventSchema)
    .query(({ ctx, input }) => getUserRank({ userId: ctx.user.id, ...input })),
});
