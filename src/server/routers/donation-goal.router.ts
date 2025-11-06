import { donateToGoalInput } from '~/server/schema/donation-goal.schema';
import { donateToGoal } from '~/server/services/donation-goal.service';
import { protectedProcedure, router } from '~/server/trpc';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';

export const donationGoalRouter = router({
  donate: protectedProcedure.input(donateToGoalInput).mutation(({ input, ctx }) => {
    return donateToGoal({
      ...input,
      userId: ctx.user.id,
      buzzType: getAllowedAccountTypes(ctx.features)[0],
    });
  }),
});
