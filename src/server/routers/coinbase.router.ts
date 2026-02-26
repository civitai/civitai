import {
  getStatus,
  createBuzzOrderHandler,
  createCodeOrderHandler,
} from '~/server/controllers/coinbase.controller';
import { createBuzzChargeSchema, createCodeOrderSchema } from '~/server/schema/coinbase.schema';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

export const coinbaseRouter = router({
  getStatus: protectedProcedure.query(getStatus),
  createBuzzOrder: protectedProcedure
    .input(createBuzzChargeSchema)
    .use(isFlagProtected('coinbasePayments'))
    .mutation(createBuzzOrderHandler),
  createCodeOrder: protectedProcedure
    .input(createCodeOrderSchema)
    .use(isFlagProtected('coinbasePayments'))
    .mutation(createCodeOrderHandler),
});
