import * as z from 'zod';
import {
  getPlansSchema,
  getUserSubscriptionSchema,
  claimPrepaidTokenSchema,
} from '~/server/schema/subscriptions.schema';
import {
  getPlansHandler,
  getUserSubscriptionHandler,
  getAllUserSubscriptionsHandler,
} from './../controllers/subscriptions.controller';
import { publicProcedure, protectedProcedure, moderatorProcedure, router } from '~/server/trpc';
import {
  claimPrepaidToken,
  claimAllPrepaidTokens,
  unlockTokensForUser,
} from '~/server/services/subscriptions.service';

export const subscriptionsRouter = router({
  getPlans: publicProcedure.input(getPlansSchema).query(getPlansHandler),
  getUserSubscription: publicProcedure
    .input(getUserSubscriptionSchema.partial().optional())
    .query(getUserSubscriptionHandler),
  getAllUserSubscriptions: publicProcedure.query(getAllUserSubscriptionsHandler),
  claimPrepaidToken: protectedProcedure
    .input(claimPrepaidTokenSchema)
    .mutation(async ({ input, ctx }) => {
      return claimPrepaidToken({ tokenId: input.tokenId, userId: ctx.user.id });
    }),
  claimAllPrepaidTokens: protectedProcedure.mutation(async ({ ctx }) => {
    return claimAllPrepaidTokens({ userId: ctx.user.id });
  }),
  unlockTokens: moderatorProcedure
    .input(z.object({ userId: z.number(), force: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      return unlockTokensForUser({ userId: input.userId, force: input.force });
    }),
});
