import {
  getStatus,
  getPriceEstimate,
  createPaymentInvoice,
} from '~/server/controllers/nowpayments.controller';
import {
  transactionCreateSchema,
  priceEstimateInputSchema,
  createPaymentInvoiceInputSchema,
} from '~/server/schema/nowpayments.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const nowPaymentsRouter = router({
  getStatus: protectedProcedure.query(getStatus),
  getPriceEstimate: protectedProcedure.input(priceEstimateInputSchema).mutation(getPriceEstimate),
  createPaymentInvoice: protectedProcedure
    .input(createPaymentInvoiceInputSchema)
    .mutation(createPaymentInvoice),
  // createBuzzPurchaseTransaction: protectedProcedure
  //   .input(transactionCreateSchema)
  //   .mutation(createBuzzPurchaseTransactionHandler),
});
