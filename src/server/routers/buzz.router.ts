import {
  createTransactionHandler,
  getUserAccountHandler,
  getUserTransactionsHandler,
} from '~/server/controllers/buzz.controller';
import {
  createBuzzTransactionInput,
  getUserBuzzTransactionsSchema,
} from '~/server/schema/buzz.schema';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

export const buzzRouter = router({
  getUserAccount: protectedProcedure.use(isFlagProtected('buzz')).query(getUserAccountHandler),
  // TODO.buzz: add another endpoint only available for mods to fetch transactions from other users
  getUserTransactions: protectedProcedure
    .input(getUserBuzzTransactionsSchema)
    .use(isFlagProtected('buzz'))
    .query(getUserTransactionsHandler),
  createTransaction: protectedProcedure
    .input(createBuzzTransactionInput)
    .use(isFlagProtected('buzz'))
    .mutation(createTransactionHandler),
});
