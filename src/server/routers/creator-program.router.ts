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
import { z } from 'zod';
import { preprocessAccountType } from '~/server/schema/buzz.schema';
import { buzzBankTypes } from '~/shared/constants/buzz.constants';

const buzzTypeSchema = z.object({
  buzzType: z.preprocess(preprocessAccountType, z.enum(buzzBankTypes)),
});

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
  getBanked: protectedProcedure.input(buzzTypeSchema).query(({ ctx, input }) => {
    return getBanked(ctx.user.id, input.buzzType);
  }),
  getWithdrawalHistory: protectedProcedure.query(({ ctx }) => getWithdrawalHistory(ctx.user.id)),

  bankBuzz: protectedProcedure.input(bankBuzzSchema).mutation(({ ctx, input }) => {
    return bankBuzz(ctx.user.id, input.amount, input.accountType);
  }),
  extractBuzz: protectedProcedure.input(buzzTypeSchema).mutation(({ ctx, input }) => {
    return extractBuzz(ctx.user.id, input.buzzType);
  }),
  withdrawCash: protectedProcedure.input(withdrawCashSchema).mutation(({ ctx, input }) => {
    return withdrawCash(ctx.user.id, input.amount);
  }),
  getPrevMonthStats: protectedProcedure.input(buzzTypeSchema).query(({ input }) => {
    return getPrevMonthStats(input.buzzType);
  }),
});
