import {
  getStatus,
  createBuzzOrderHandler,
  createBuzzOrderOnrampHandler,
  getTransactionStatusHandler,
  getPaginatedUserTransactionsHandler,
  getUserWalletBalanceHandler,
  processUserPendingTransactionsHandler,
} from '~/server/controllers/coinbase.controller';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import {
  createBuzzChargeSchema,
  getPaginatedUserTransactionHistorySchema,
} from '~/server/schema/coinbase.schema';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

export const coinbaseRouter = router({
  getStatus: protectedProcedure.query(getStatus),
  createBuzzOrder: protectedProcedure
    .input(createBuzzChargeSchema)
    .use(isFlagProtected('coinbasePayments'))
    .mutation(createBuzzOrderHandler),
  createBuzzOrderOnramp: protectedProcedure
    .input(createBuzzChargeSchema)
    .use(isFlagProtected('coinbaseOnramp'))
    .mutation(createBuzzOrderOnrampHandler),
  getTransactionStatus: protectedProcedure
    .input(getByIdStringSchema)
    .query(getTransactionStatusHandler),
  getUserWalletBalance: protectedProcedure.query(getUserWalletBalanceHandler),
  getPaginatedUserTransactions: protectedProcedure
    .input(getPaginatedUserTransactionHistorySchema)
    .query(getPaginatedUserTransactionsHandler),
  processUserPendingTransactions: protectedProcedure.mutation(
    processUserPendingTransactionsHandler
  ),
});
