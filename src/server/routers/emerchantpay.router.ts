import { router, protectedProcedure, publicProcedure, isFlagProtected } from '~/server/trpc';
import {
  createBuzzOrderHandler,
  getStatus,
  getTransactionStatusHandler,
} from '~/server/controllers/emerchantpay.controller';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import { createBuzzChargeSchema } from '~/server/schema/emerchantpay.schema';

export const emerchantpayRouter = router({
  getStatus: publicProcedure.query(() => getStatus()),

  createBuzzOrder: protectedProcedure
    .input(createBuzzChargeSchema)
    .use(isFlagProtected('emerchantpayPayments'))
    .mutation(({ input, ctx }) => createBuzzOrderHandler({ input, ctx })),

  getTransactionStatus: protectedProcedure
    .input(getByIdStringSchema)
    .query(({ input, ctx }) => getTransactionStatusHandler({ input, ctx })),
});
