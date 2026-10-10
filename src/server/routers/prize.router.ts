import { rateLimit } from '~/server/middleware.trpc';
import { claimPrizeSchema, getMyPrizesSchema, getPrizeSchema } from '~/server/schema/prize.schema';
import {
  claimPrize,
  getMyPrizes,
  getPrize,
  getRequestPrizeBuzzChoices,
} from '~/server/services/prize.service';
import { protectedProcedure, router } from '~/server/trpc';

// protectedProcedure, not guardedProcedure: a muted winner still collects what they won.
export const prizeRouter = router({
  getMine: protectedProcedure
    .input(getMyPrizesSchema)
    .query(({ ctx, input }) =>
      getMyPrizes({ ...input, userId: ctx.user.id, choices: getRequestPrizeBuzzChoices(ctx.req) })
    ),
  getById: protectedProcedure
    .input(getPrizeSchema)
    .query(({ ctx, input }) =>
      getPrize({ id: input.id, userId: ctx.user.id, choices: getRequestPrizeBuzzChoices(ctx.req) })
    ),
  claim: protectedProcedure
    .use(rateLimit({ limit: 30, period: 60 }))
    .input(claimPrizeSchema)
    .mutation(({ ctx, input }) =>
      claimPrize({
        id: input.id,
        userId: ctx.user.id,
        buzzType: input.buzzType,
        choices: getRequestPrizeBuzzChoices(ctx.req),
      })
    ),
});
