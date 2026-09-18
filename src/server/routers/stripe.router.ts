import {
  createCustomerHandler,
  createSubscriptionSessionHandler,
  createManageSubscriptionSessionHandler,
  createDonateSessionHandler,
  getBuzzPackagesHandler,
  getPaymentIntentHandler,
  getSetupIntentHandler,
  createCancelSubscriptionSessionHandler,
  cancelSubscriptionWithFallbackHandler,
} from './../controllers/stripe.controller';
import { publicProcedure, router, protectedProcedure } from '~/server/trpc';
import * as Schema from '../schema/stripe.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const stripeRouter = router({
  createCustomer: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(Schema.createCustomerSchema)
    .mutation(createCustomerHandler),
  createSubscriptionSession: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(Schema.createSubscribeSessionSchema)
    .mutation(createSubscriptionSessionHandler),
  createManageSubscriptionSession: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .mutation(createManageSubscriptionSessionHandler),
  createCancelSubscriptionSession: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .mutation(createCancelSubscriptionSessionHandler),
  cancelSubscriptionWithFallback: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .mutation(cancelSubscriptionWithFallbackHandler),
  createDonateSession: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(Schema.createDonateSessionSchema)
    .mutation(createDonateSessionHandler),
  getBuzzPackages: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .query(getBuzzPackagesHandler),
  getPaymentIntent: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(Schema.paymentIntentCreationSchema)
    .mutation(getPaymentIntentHandler),
  getSetupIntent: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(Schema.setupIntentCreateSchema)
    .query(getSetupIntentHandler),
});
