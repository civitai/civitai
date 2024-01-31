import { airConfirmSchema } from '~/server/schema/integration.schema';
import { confirmAir, getAirStatus } from '~/server/services/integration.service';
import { protectedProcedure, router } from '~/server/trpc';

export const integrationRouter = router({
  airStatus: protectedProcedure.query(({ ctx }) => getAirStatus(ctx.user.id)),
  airConfirm: protectedProcedure
    .input(airConfirmSchema)
    .mutation(({ input, ctx }) => confirmAir({ email: input.email, userId: ctx.user.id })),
});
