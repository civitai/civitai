import { getStatus, getPriceEstimate } from '~/server/controllers/nowpayments.controller';
import {
  transactionCreateSchema,
  priceEstimateInputSchema,
} from '~/server/schema/nowpayments.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const nowPaymentsRouter = router({
  getStatus: protectedProcedure.query(getStatus),
  getPriceEstimate: protectedProcedure.input(priceEstimateInputSchema).query(getPriceEstimate),
  // createBuzzPurchaseTransaction: protectedProcedure
  //   .input(transactionCreateSchema)
  //   .mutation(createBuzzPurchaseTransactionHandler),
});
