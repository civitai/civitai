import {
  createTransactionHandler,
  cancelSubscriptionHandler,
  processCompleteBuzzTransactionHandler,
  updateSubscriptionPlanHandler,
} from '~/server/controllers/paddle.controller';
import { router, protectedProcedure } from '~/server/trpc';
import {
  transactionCreateSchema,
  updateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import { getByIdStringSchema } from '~/server/schema/base.schema';

export const paddleRouter = router({
  createTrasaction: protectedProcedure
    .input(transactionCreateSchema)
    .mutation(createTransactionHandler),
  processCompleteBuzzTransaction: protectedProcedure
    .input(getByIdStringSchema)
    .mutation(processCompleteBuzzTransactionHandler),
  updateSubscription: protectedProcedure
    .input(updateSubscriptionInputSchema)
    .mutation(updateSubscriptionPlanHandler),
  cancelSubscription: protectedProcedure.mutation(cancelSubscriptionHandler),
});
