import { updateSubscriptionSchema } from '~/server/schema/newsletter.schema';
import {
  getSubscription,
  postponeSubscription,
  updateSubscription,
} from '~/server/services/newsletter.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const newsletterRouter = router({
  getSubscription: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getSubscription(ctx.user?.email)),
  updateSubscription: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(updateSubscriptionSchema)
    .mutation(({ input, ctx }) =>
      // The email is taken from the session, never from input: a client-supplied address let an
      // anonymous caller unsubscribe anyone whose address they knew, or sign a stranger up and
      // have Beehiiv mail them under our sender identity.
      updateSubscription({
        ...input,
        email: ctx.user.email,
        userId: ctx.user.id,
      })
    ),
  postpone: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .mutation(({ ctx }) => postponeSubscription(ctx.user.id)),
});
