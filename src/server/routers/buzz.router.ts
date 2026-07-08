import {
  claimDailyBoostRewardHandler,
  completeStripeBuzzPurchaseHandler,
  createBuzzTipTransactionHandler,
  depositClubFundsHandler,
  getBuzzAccountHandler,
  getBuzzAccountTransactionsHandler,
  getDailyCompensationRewardHandler,
  getTransactionsReportHandler,
  getUserAccountHandler,
  getUserMultipliersHandler,
  getUserTransactionsHandler,
  previewMultiAccountTransactionHandler,
  withdrawClubFundsHandler,
} from '~/server/controllers/buzz.controller';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import {
  claimWatchedAdRewardSchema,
  clubTransactionSchema,
  completeStripeBuzzPurchaseTransactionInput,
  getBuzzAccountSchema,
  getBuzzAccountTransactionsSchema,
  getDailyBuzzCompensationInput,
  getEarnPotentialSchema,
  getTransactionsReportSchema,
  getUserBuzzTransactionsSchema,
  previewMultiAccountTransactionInput,
  userBuzzTransactionInputSchema,
} from '~/server/schema/buzz.schema';
import {
  claimBuzz,
  claimWatchedAdReward,
  getClaimStatus,
  getEarnPotential,
  getPoolForecast,
  getUserBuzzAccounts,
} from '~/server/services/buzz.service';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const buzzProcedure = protectedProcedure.use(isFlagProtected('buzz'));

export const buzzRouter = router({
  getUserAccount: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .query(getUserAccountHandler),
  // getBuzzAccount: buzzProcedure.input(getBuzzAccountSchema).query(getBuzzAccountHandler),
  getBuzzAccount: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .query(({ ctx }) => getUserBuzzAccounts({ userId: ctx.user.id })),
  // TODO.buzz: add another endpoint only available for mods to fetch transactions from other users
  getUserTransactions: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getUserBuzzTransactionsSchema)
    .query(getUserTransactionsHandler),
  tipUser: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialTip, blockApiKeys: true })
    .use(isFlagProtected('buzz'))
    .input(userBuzzTransactionInputSchema)
    .mutation(createBuzzTipTransactionHandler),
  completeStripeBuzzPurchase: buzzProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(completeStripeBuzzPurchaseTransactionInput)
    .mutation(completeStripeBuzzPurchaseHandler),
  getAccountTransactions: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getBuzzAccountTransactionsSchema)
    .query(getBuzzAccountTransactionsHandler),
  withdrawClubFunds: buzzProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(clubTransactionSchema)
    .use(isFlagProtected('clubs'))
    .mutation(withdrawClubFundsHandler),
  depositClubFunds: buzzProcedure
    .meta({ blockApiKeys: true })
    .input(clubTransactionSchema)
    .use(isFlagProtected('clubs'))
    .mutation(depositClubFundsHandler),
  getClaimStatus: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getByIdStringSchema)
    .query(({ input, ctx }) => getClaimStatus({ ...input, userId: ctx.user.id })),
  claim: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getByIdStringSchema)
    .mutation(({ input, ctx }) => claimBuzz({ ...input, userId: ctx.user.id })),
  getUserMultipliers: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .query(getUserMultipliersHandler),
  claimDailyBoostReward: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .mutation(claimDailyBoostRewardHandler),
  getEarnPotential: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getEarnPotentialSchema)
    .query(({ input, ctx }) => {
      if (!ctx.user.isModerator) input.userId = ctx.user.id;
      if (!input.username && !input.userId) input.userId = ctx.user.id;
      return getEarnPotential(input);
    }),
  getPoolForecast: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getEarnPotentialSchema)
    .query(({ input, ctx }) => {
      if (!ctx.user.isModerator) input.userId = ctx.user.id;
      if (!input.username && !input.userId) input.userId = ctx.user.id;
      return getPoolForecast(input);
    }),
  getDailyBuzzCompensation: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getDailyBuzzCompensationInput)
    .query(getDailyCompensationRewardHandler),
  claimWatchedAdReward: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(claimWatchedAdRewardSchema)
    .mutation(({ input, ctx }) =>
      claimWatchedAdReward({ ...input, userId: ctx.user.id, ip: ctx.ip })
    ),
  getTransactionsReport: protectedProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(getTransactionsReportSchema)
    .query(getTransactionsReportHandler),
  // Multi-account transaction endpoints
  previewMultiAccountTransaction: buzzProcedure
    .meta({ requiredScope: TokenScope.BuzzRead })
    .input(previewMultiAccountTransactionInput.omit({ fromAccountId: true }))
    .query(previewMultiAccountTransactionHandler),
});
