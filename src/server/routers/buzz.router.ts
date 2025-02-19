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
  claimWatchedAdRewardSchema,
  getTransactionsReportSchema,
} from '~/server/schema/buzz.schema';
import {
  claimBuzz,
  claimWatchedAdReward,
  getClaimStatus,
  getEarnPotential,
  getPoolForecast,
} from '~/server/services/buzz.service';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

const buzzProcedure = protectedProcedure.use(isFlagProtected('buzz'));

export const buzzRouter = router({
  getUserAccount: buzzProcedure.query(getUserAccountHandler),
  getBuzzAccount: buzzProcedure.input(getBuzzAccountSchema).query(getBuzzAccountHandler),
  // TODO.buzz: add another endpoint only available for mods to fetch transactions from other users
  getUserTransactions: buzzProcedure
    .input(getUserBuzzTransactionsSchema)
    .query(getUserTransactionsHandler),
  tipUser: buzzProcedure
    .input(userBuzzTransactionInputSchema)
    .mutation(createBuzzTipTransactionHandler),
  completeStripeBuzzPurchase: buzzProcedure
    .input(completeStripeBuzzPurchaseTransactionInput)
    .mutation(completeStripeBuzzPurchaseHandler),
  getAccountTransactions: buzzProcedure
    .input(getBuzzAccountTransactionsSchema)
    .query(getBuzzAccountTransactionsHandler),
  withdrawClubFunds: buzzProcedure
    .input(clubTransactionSchema)
    .use(isFlagProtected('clubs'))
    .mutation(withdrawClubFundsHandler),
  depositClubFunds: buzzProcedure
    .input(clubTransactionSchema)
    .use(isFlagProtected('clubs'))
    .mutation(depositClubFundsHandler),
  getClaimStatus: buzzProcedure
    .input(getByIdStringSchema)
    .query(({ input, ctx }) => getClaimStatus({ ...input, userId: ctx.user.id })),
  claim: buzzProcedure
    .input(getByIdStringSchema)
    .mutation(({ input, ctx }) => claimBuzz({ ...input, userId: ctx.user.id })),
  getUserMultipliers: buzzProcedure.query(getUserMultipliersHandler),
  claimDailyBoostReward: buzzProcedure.mutation(claimDailyBoostRewardHandler),
  getEarnPotential: buzzProcedure.input(getEarnPotentialSchema).query(({ input, ctx }) => {
    if (!ctx.user.isModerator) input.userId = ctx.user.id;
    if (!input.username && !input.userId) input.userId = ctx.user.id;
    return getEarnPotential(input);
  }),
  getPoolForecast: buzzProcedure.input(getEarnPotentialSchema).query(({ input, ctx }) => {
    if (!ctx.user.isModerator) input.userId = ctx.user.id;
    if (!input.username && !input.userId) input.userId = ctx.user.id;
    return getPoolForecast(input);
  }),
  getDailyBuzzCompensation: buzzProcedure
    .input(getDailyBuzzCompensationInput)
    .query(getDailyCompensationRewardHandler),
  claimWatchedAdReward: buzzProcedure
    .input(claimWatchedAdRewardSchema)
    .mutation(({ input, ctx }) =>
      claimWatchedAdReward({ ...input, userId: ctx.user.id, ip: ctx.ip })
    ),
  getTransactionsReport: protectedProcedure
    .input(getTransactionsReportSchema)
    .query(getTransactionsReportHandler),
});
