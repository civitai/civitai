import { updateSubscriptionSchema } from '~/server/schema/newsletter.schema';
import {
  getSubscription,
  postponeSubscription,
  updateSubscription,
} from '~/server/services/newsletter.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const newsletterRouter = router({
  getSubscription: publicProcedure.query(({ ctx }) => getSubscription(ctx.user?.email)),
  updateSubscription: publicProcedure
    .input(updateSubscriptionSchema)
    .mutation(({ input, ctx }) =>
      updateSubscription({ ...input, sessionEmail: ctx.user?.email, username: ctx.user?.username })
    ),
  postpone: protectedProcedure.mutation(({ ctx }) => postponeSubscription(ctx.user.id)),
});
