import { bankBuzzSchema, withdrawCashSchema } from '~/server/schema/creator-program.schema';
import {
  bankBuzz,
  extractBuzz,
  getCash,
  getCompensationPool,
  getCreatorRequirements,
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
    joinCreatorsProgram(ctx.user.id);
  }),
  getCompensationPool: protectedProcedure.query(getCompensationPool),
  getCash: protectedProcedure.query(({ ctx }) => getCash(ctx.user.id)),
  getWithdrawalHistory: protectedProcedure.query(({ ctx }) => getWithdrawalHistory(ctx.user.id)),

  bankBuzz: protectedProcedure.input(bankBuzzSchema).mutation(({ ctx, input }) => {
    bankBuzz(ctx.user.id, input.amount);
  }),
  extractBuzz: protectedProcedure.mutation(({ ctx }) => {
    extractBuzz(ctx.user.id);
  }),
  withdrawCash: protectedProcedure.input(withdrawCashSchema).mutation(({ ctx, input }) => {
    withdrawCash(ctx.user.id, input.amount);
  }),
});
