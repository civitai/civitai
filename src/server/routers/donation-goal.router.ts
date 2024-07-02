import { donateToGoalInput } from '~/server/schema/donation-goal.schema';
import { donateToGoal } from '~/server/services/donation-goal.service';
import { protectedProcedure, router } from '~/server/trpc';

export const donationGoalRouter = router({
  donate: protectedProcedure.input(donateToGoalInput).mutation(({ input, ctx }) => {
    return donateToGoal({
      ...input,
      userId: ctx.user.id,
    });
  }),
});
