import {
  consumeRedeemableCodeSchema,
  createRedeemableCodeSchema,
  deleteRedeemableCodeSchema,
} from '~/server/schema/redeemableCode.schema';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import {
  consumeRedeemableCode,
  createRedeemableCode,
  deleteRedeemableCode,
} from '~/server/services/redeemableCode.service';
import { handleTRPCError } from '~/server/utils/errorHandling';

export const redeemableCodeRouter = router({
  create: moderatorProcedure
    .input(createRedeemableCodeSchema)
    .mutation(({ input }) => createRedeemableCode(input).catch(handleTRPCError)),
  delete: moderatorProcedure
    .input(deleteRedeemableCodeSchema)
    .mutation(({ input }) => deleteRedeemableCode(input).catch(handleTRPCError)),
  consume: protectedProcedure
    .input(consumeRedeemableCodeSchema)
    .mutation(({ input, ctx }) =>
      consumeRedeemableCode({ ...input, userId: input.userId ?? ctx.user?.id }).catch(
        handleTRPCError
      )
    ),
});
