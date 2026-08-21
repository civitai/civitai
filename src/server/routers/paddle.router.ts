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
  cancelEmailHandler,
} from '~/server/controllers/paddle.controller';
import { router, protectedProcedure } from '~/server/trpc';
import {
  transactionCreateSchema,
  transactionWithSubscriptionCreateSchema,
  updateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import { refreshSubscription } from '../services/paddle.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const paddleRouter = router({
  createBuzzPurchaseTransaction: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(transactionCreateSchema)
    .mutation(createBuzzPurchaseTransactionHandler),
  processCompleteBuzzTransaction: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(getByIdStringSchema)
    .mutation(processCompleteBuzzTransactionHandler),
  updateSubscription: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(updateSubscriptionInputSchema)
    .mutation(updateSubscriptionPlanHandler),
  // cancelSubscription: protectedProcedure.mutation(cancelSubscriptionHandler),
  cancelSubscription: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .mutation(cancelEmailHandler),
  purchaseBuzzWithSubscription: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(transactionWithSubscriptionCreateSchema)
    .mutation(purchaseBuzzWithSubscriptionHandler),
  getManagementUrls: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .query(getManagementUrlsHandler),
  getOrCreateCustomer: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .mutation(getOrCreateCustomerHandler),
  refreshSubscription: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .mutation(refreshSubscriptionHandler),
  hasSubscription: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .query(hasPaddleSubscriptionHandler),
});
