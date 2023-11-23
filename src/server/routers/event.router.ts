import { z } from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { eventSchema } from '~/server/schema/event.schema';
import {
  activateEventCosmetic,
  donate,
  getEventCosmetic,
  getTeamScores,
} from '~/server/services/event.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const eventRouter = router({
  getTeamScores: publicProcedure
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(({ input }) => getTeamScores(input)),
  getTeamScoreHistory: publicProcedure
    .input(eventSchema)
    .use(edgeCacheIt({ ttl: CacheTTL.lg }))
    .query(({ input }) => getTeamScores(input)),
  getCosmetic: protectedProcedure
    .input(eventSchema)
    .query(({ ctx, input }) => getEventCosmetic({ userId: ctx.user.id, ...input })),
  activateCosmetic: protectedProcedure
    .input(eventSchema)
    .mutation(({ ctx, input }) => activateEventCosmetic({ userId: ctx.user.id, ...input })),
  donate: protectedProcedure
    .input(eventSchema.extend({ amount: z.number() }))
    .mutation(({ input, ctx }) => donate({ userId: ctx.user.id, ...input })),
});
