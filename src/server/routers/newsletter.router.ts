import { updateSubscriptionSchema } from '~/server/schema/newsletter.schema';
import { getSubscription, updateSubscription } from '~/server/services/newsletter.service';
import { protectedProcedure, router } from '~/server/trpc';

export const newsletterRouter = router({
  getSubscription: protectedProcedure.query(({ ctx }) => getSubscription(ctx.user.email)),
  updateSubscription: protectedProcedure
    .input(updateSubscriptionSchema)
    .mutation(({ input, ctx }) => updateSubscription({ email: ctx.user.email, ...input })),
});
