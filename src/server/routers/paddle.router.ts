import {
  createBuzzPurchaseTransactionHandler,
  cancelSubscriptionHandler,
  processCompleteBuzzTransactionHandler,
  updateSubscriptionPlanHandler,
  purchaseBuzzWithSubscriptionHandler,
  getManagementUrlsHandler,
  getOrCreateCustomerHandler,
  refreshSubscriptionHandler,
  hasPaddleSubscriptionHandler,
  getAdjustmentsInfiniteHandler,
  cancelEmailHandler,
} from '~/server/controllers/paddle.controller';
import { router, protectedProcedure, moderatorProcedure } from '~/server/trpc';
import {
  getPaddleAdjustmentsSchema,
  transactionCreateSchema,
  transactionWithSubscriptionCreateSchema,
  updateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import { refreshSubscription } from '../services/paddle.service';

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
  // cancelSubscription: protectedProcedure.mutation(cancelSubscriptionHandler),
  cancelSubscription: protectedProcedure.mutation(cancelEmailHandler),
  purchaseBuzzWithSubscription: protectedProcedure
    .input(transactionWithSubscriptionCreateSchema)
    .mutation(purchaseBuzzWithSubscriptionHandler),
  getManagementUrls: protectedProcedure.query(getManagementUrlsHandler),
  getOrCreateCustomer: protectedProcedure.mutation(getOrCreateCustomerHandler),
  refreshSubscription: protectedProcedure.mutation(refreshSubscriptionHandler),
  hasSubscription: protectedProcedure.query(hasPaddleSubscriptionHandler),
  getAdjustmentsInfinite: moderatorProcedure
    .input(getPaddleAdjustmentsSchema)
    .query(getAdjustmentsInfiniteHandler),
});
