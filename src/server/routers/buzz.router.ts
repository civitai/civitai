import {
  completeStripeBuzzPurchaseHandler,
  createBuzzTipTransactionHandler,
  depositClubFundsHandler,
  getBuzzAccountHandler,
  getBuzzAccountTransactionsHandler,
  getUserAccountHandler,
  getUserTransactionsHandler,
  withdrawClubFundsHandler,
} from '~/server/controllers/buzz.controller';
import {
  completeStripeBuzzPurchaseTransactionInput,
  getBuzzAccountSchema,
  getBuzzAccountTransactionsSchema,
  getUserBuzzTransactionsSchema,
  userBuzzTransactionInputSchema,
  clubTransactionSchema,
} from '~/server/schema/buzz.schema';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

export const buzzRouter = router({
  getUserAccount: protectedProcedure.use(isFlagProtected('buzz')).query(getUserAccountHandler),
  getBuzzAccount: protectedProcedure
    .input(getBuzzAccountSchema)
    .use(isFlagProtected('buzz'))
    .query(getBuzzAccountHandler),
  // TODO.buzz: add another endpoint only available for mods to fetch transactions from other users
  getUserTransactions: protectedProcedure
    .input(getUserBuzzTransactionsSchema)
    .use(isFlagProtected('buzz'))
    .query(getUserTransactionsHandler),
  tipUser: protectedProcedure
    .input(userBuzzTransactionInputSchema)
    .use(isFlagProtected('buzz'))
    .mutation(createBuzzTipTransactionHandler),
  completeStripeBuzzPurchase: protectedProcedure
    .input(completeStripeBuzzPurchaseTransactionInput)
    .use(isFlagProtected('buzz'))
    .mutation(completeStripeBuzzPurchaseHandler),
  getAccountTransactions: protectedProcedure
    .input(getBuzzAccountTransactionsSchema)
    .use(isFlagProtected('buzz'))
    .query(getBuzzAccountTransactionsHandler),
  withdrawClubFunds: protectedProcedure
    .input(clubTransactionSchema)
    .use(isFlagProtected('buzz'))
    .use(isFlagProtected('clubs'))
    .mutation(withdrawClubFundsHandler),
  depositClubFunds: protectedProcedure
    .input(clubTransactionSchema)
    .use(isFlagProtected('buzz'))
    .use(isFlagProtected('clubs'))
    .mutation(depositClubFundsHandler),
});
