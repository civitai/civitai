import {
  createCustomerHandler,
  getPlansHandler,
  createSubscriptionSessionHandler,
} from './../controllers/stripe.controller';
import { publicProcedure, router, protectedProcedure } from '~/server/trpc';
import * as Schema from '../schema/stripe.schema';

export const stripeRouter = router({
  getPlans: publicProcedure.query(getPlansHandler),
  createCustomer: protectedProcedure
    .input(Schema.createCustomerSchema)
    .mutation(createCustomerHandler),
  createSubscriptionSession: protectedProcedure
    .input(Schema.createSubscribeSessionSchema)
    .mutation(createSubscriptionSessionHandler),
});
