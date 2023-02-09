import {
  createCustomerHandler,
  getPlansHandler,
  createSubscriptionSessionHandler,
  createManageSubscriptionSessionHandler,
  getUserSubscriptionHandler,
  createDonateSessionHandler,
} from './../controllers/stripe.controller';
import { publicProcedure, router, protectedProcedure } from '~/server/trpc';
import * as Schema from '../schema/stripe.schema';

export const stripeRouter = router({
  getPlans: publicProcedure.query(getPlansHandler),
  getUserSubscription: publicProcedure.query(getUserSubscriptionHandler),
  createCustomer: protectedProcedure
    .input(Schema.createCustomerSchema)
    .mutation(createCustomerHandler),
  createSubscriptionSession: protectedProcedure
    .input(Schema.createSubscribeSessionSchema)
    .mutation(createSubscriptionSessionHandler),
  createManageSubscriptionSession: protectedProcedure.mutation(
    createManageSubscriptionSessionHandler
  ),
  createDonateSession: protectedProcedure
    .input(Schema.createDonateSessionSchema)
    .mutation(createDonateSessionHandler),
});
