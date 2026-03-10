import { toggleReactionHandler } from './../controllers/reaction.controller';
import { toggleReactionSchema, reactionRateLimits } from './../schema/reaction.schema';
import { router, guardedProcedure } from '~/server/trpc';
import { rateLimit } from '~/server/middleware.trpc';
import { handleLogError } from '~/server/utils/errorHandling';

export const reactionRouter = router({
  toggle: guardedProcedure
    .input(toggleReactionSchema)
    .use(rateLimit(reactionRateLimits))
    .mutation(({ ctx, input }) => {
      // Fire-and-forget: frontend already does optimistic updates via Zustand
      // and ignores the response value entirely (no onSuccess/onError callbacks).
      // Auth + rate limit middleware have already run at this point.
      toggleReactionHandler({ ctx, input }).catch(handleLogError);
    }),
});
