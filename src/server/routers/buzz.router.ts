import {
  createTransactionHandler,
  getUserAccountHandler,
  getUserTransactionsHandler,
} from '~/server/controllers/buzz.controller';
import {
  createBuzzTransactionInput,
  getUserBuzzTransactionsSchema,
} from '~/server/schema/buzz.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const buzzRouter = router({
  getUserAccount: protectedProcedure.query(getUserAccountHandler),
  // TODO.buzz: add another endpoint only available for mods to fetch transactions from other users
  getUserTransactions: protectedProcedure
    .input(getUserBuzzTransactionsSchema)
    .query(getUserTransactionsHandler),
  createTransaction: protectedProcedure
    .input(createBuzzTransactionInput)
    .mutation(createTransactionHandler),
});
