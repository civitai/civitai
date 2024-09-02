import {
  createBuzzPurchaseTransactionHandler,
  cancelSubscriptionHandler,
  processCompleteBuzzTransactionHandler,
  updateSubscriptionPlanHandler,
  purchaseBuzzWithSubscriptionHandler,
  getManagementUrlsHandler,
  getOrCreateCustomerHandler,
} from '~/server/controllers/paddle.controller';
import { router, protectedProcedure } from '~/server/trpc';
import {
  transactionCreateSchema,
  transactionWithSubscriptionCreateSchema,
  updateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import { getByIdStringSchema } from '~/server/schema/base.schema';

export const paddleRouter = router({
  createBuzzPurchaseTransaction: protectedProcedure
    .input(transactionCreateSchema)
    .mutation(createBuzzPurchaseTransactionHandler),
  processCompleteBuzzTransaction: protectedProcedure
    .input(getByIdStringSchema)
    .mutation(processCompleteBuzzTransactionHandler),
  updateSubscription: protectedProcedure
    .input(updateSubscriptionInputSchema)
    .mutation(updateSubscriptionPlanHandler),
  cancelSubscription: protectedProcedure.mutation(cancelSubscriptionHandler),
  purchaseBuzzWithSubscription: protectedProcedure
    .input(transactionWithSubscriptionCreateSchema)
    .mutation(purchaseBuzzWithSubscriptionHandler),
  getManagementUrls: protectedProcedure.query(getManagementUrlsHandler),
  getOrCreateCustomer: protectedProcedure.mutation(getOrCreateCustomerHandler),
});
