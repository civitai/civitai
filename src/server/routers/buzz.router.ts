import {
  claimDailyBoostRewardHandler,
  completeStripeBuzzPurchaseHandler,
  createBuzzTipTransactionHandler,
  depositClubFundsHandler,
  getBuzzAccountHandler,
  getBuzzAccountTransactionsHandler,
  getUserAccountHandler,
  getUserMultipliersHandler,
  getUserTransactionsHandler,
  withdrawClubFundsHandler,
} from '~/server/controllers/buzz.controller';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import {
  completeStripeBuzzPurchaseTransactionInput,
  getBuzzAccountSchema,
  getBuzzAccountTransactionsSchema,
  getUserBuzzTransactionsSchema,
  userBuzzTransactionInputSchema,
  clubTransactionSchema,
  getEarnPotentialSchema,
  getDailyBuzzCompensationInput,
} from '~/server/schema/buzz.schema';
import {
  claimBuzz,
  getClaimStatus,
  getDailyBuzzPayoutByUser,
  getEarnPotential,
} from '~/server/services/buzz.service';
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
  getClaimStatus: protectedProcedure
    .input(getByIdStringSchema)
    .query(({ input, ctx }) => getClaimStatus({ ...input, userId: ctx.user.id })),
  claim: protectedProcedure
    .input(getByIdStringSchema)
    .mutation(({ input, ctx }) => claimBuzz({ ...input, userId: ctx.user.id })),
  getUserMultipliers: protectedProcedure.query(getUserMultipliersHandler),
  claimDailyBoostReward: protectedProcedure.mutation(claimDailyBoostRewardHandler),
  getEarnPotential: protectedProcedure.input(getEarnPotentialSchema).query(({ input, ctx }) => {
    if (!ctx.user.isModerator) input.userId = ctx.user.id;
    if (!input.username && !input.userId) input.userId = ctx.user.id;
    return getEarnPotential(input);
  }),
  getDailyBuzzCompensation: protectedProcedure
    .input(getDailyBuzzCompensationInput)
    .query(({ input, ctx }) => {
      if (!ctx.user.isModerator) input.userId = ctx.user.id;
      if (!input.userId) input.userId = ctx.user.id;
      return getDailyBuzzPayoutByUser(input);
    }),
});
