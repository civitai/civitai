import {
  createBuzzOrderHandler,
  processBuzzOrderHandler,
} from './../controllers/paypal.controller';
import { router, protectedProcedure } from '~/server/trpc';
import { paypalOrderSchema, paypalPurchaseBuzzSchema } from '../schema/paypal.schema';

export const paypalRouter = router({
  createBuzzOrder: protectedProcedure
    .input(paypalPurchaseBuzzSchema)
    .mutation(createBuzzOrderHandler),
  processBuzzOrder: protectedProcedure.input(paypalOrderSchema).mutation(processBuzzOrderHandler),
});
