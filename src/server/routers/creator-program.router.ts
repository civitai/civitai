import {
  bankBuzzSchema,
  compensationPoolInputSchema,
  withdrawCashSchema,
} from '~/server/schema/creator-program.schema';
import {
  bankBuzz,
  extractBuzz,
  getBanked,
  getCash,
  getCompensationPool,
  getCreatorRequirements,
  getPrevMonthStats,
  getWithdrawalHistory,
  joinCreatorsProgram,
  withdrawCash,
} from '~/server/services/creator-program.service';
import { protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const creatorProgramRouter = router({
  getCreatorRequirements: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getCreatorRequirements(ctx.user.id)),
  joinCreatorsProgram: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .mutation(({ ctx }) => {
      return joinCreatorsProgram(ctx.user.id);
    }),
  getCompensationPool: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(compensationPoolInputSchema)
    .query(({ input }) => getCompensationPool(input)),
  getCash: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getCash(ctx.user.id)),
  getBanked: protectedProcedure.meta({ requiredScope: TokenScope.UserRead }).query(({ ctx }) => {
    return getBanked(ctx.user.id);
  }),
  getWithdrawalHistory: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getWithdrawalHistory(ctx.user.id)),

  bankBuzz: protectedProcedure
    .meta({ requiredScope: TokenScope.Full, blockApiKeys: true })
    .input(bankBuzzSchema)
    .mutation(({ ctx, input }) => {
      return bankBuzz(ctx.user.id, input.amount, input.accountType, input.idempotencyKey);
    }),
  extractBuzz: protectedProcedure
    .meta({ requiredScope: TokenScope.Full, blockApiKeys: true })
    .mutation(({ ctx }) => {
      return extractBuzz(ctx.user.id);
    }),
  withdrawCash: protectedProcedure
    .meta({ requiredScope: TokenScope.Full, blockApiKeys: true })
    .input(withdrawCashSchema)
    .mutation(({ ctx, input }) => {
      return withdrawCash(ctx.user.id, input.amount, input.idempotencyKey);
    }),
  getPrevMonthStats: protectedProcedure.meta({ requiredScope: TokenScope.Full }).query(() => {
    return getPrevMonthStats();
  }),
});
