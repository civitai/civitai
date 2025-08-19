import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { cacheIt, edgeCacheIt } from '~/server/middleware.trpc';
import type { EventInput } from '~/server/schema/event.schema';
import { eventSchema, teamScoreHistorySchema } from '~/server/schema/event.schema';
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
} from '~/server/services/event.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const eventRouter = router({
  getData: publicProcedure
    .input(eventSchema)
    // .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ input }) => getEventData(input)),
  getTeamScores: publicProcedure
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input }) => getTeamScores(input)),
  getTeamScoreHistory: publicProcedure
    .input(teamScoreHistorySchema)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input }) => getTeamScoreHistory(input)),
  getCosmetic: protectedProcedure
    .input(eventSchema)
    .query(({ ctx, input }) => getEventCosmetic({ userId: ctx.user.id, ...input })),
  getPartners: publicProcedure
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.day }))
    .query(({ input }) => getEventPartners(input)),
  getRewards: publicProcedure
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ input }) => getEventRewards(input)),
  activateCosmetic: protectedProcedure
    .input(eventSchema)
    .mutation(({ ctx, input }) => activateEventCosmetic({ userId: ctx.user.id, ...input })),
  donate: protectedProcedure
    .input(eventSchema.extend({ amount: z.number() }))
    .mutation(({ input, ctx }) => donate({ userId: ctx.user.id, ...input })),
  getDonors: publicProcedure
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
  getUserRank: protectedProcedure
    .input(eventSchema)
    .query(({ ctx, input }) => getUserRank({ userId: ctx.user.id, ...input })),
});
