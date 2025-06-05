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

export const creatorProgramRouter = router({
  getCreatorRequirements: protectedProcedure.query(({ ctx }) =>
    getCreatorRequirements(ctx.user.id)
  ),
  joinCreatorsProgram: protectedProcedure.mutation(({ ctx }) => {
    return joinCreatorsProgram(ctx.user.id);
  }),
  getCompensationPool: protectedProcedure
    .input(compensationPoolInputSchema)
    .query(({ input }) => getCompensationPool(input)),
  getCash: protectedProcedure.query(({ ctx }) => getCash(ctx.user.id)),
  getBanked: protectedProcedure.query(({ ctx }) => getBanked(ctx.user.id)),
  getWithdrawalHistory: protectedProcedure.query(({ ctx }) => getWithdrawalHistory(ctx.user.id)),

  bankBuzz: protectedProcedure.input(bankBuzzSchema).mutation(({ ctx, input }) => {
    return bankBuzz(ctx.user.id, input.amount);
  }),
  extractBuzz: protectedProcedure.mutation(({ ctx }) => {
    return extractBuzz(ctx.user.id);
  }),
  withdrawCash: protectedProcedure.input(withdrawCashSchema).mutation(({ ctx, input }) => {
    return withdrawCash(ctx.user.id, input.amount);
  }),
  getPrevMonthStats: protectedProcedure.query(({ ctx }) => getPrevMonthStats()),
});
