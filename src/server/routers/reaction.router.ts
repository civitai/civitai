import { toggleReactionHandler } from './../controllers/reaction.controller';
import { toggleReactionSchema, reactionRateLimits } from './../schema/reaction.schema';
import { router, guardedProcedure } from '~/server/trpc';
import { rateLimit } from '~/server/middleware.trpc';

export const reactionRouter = router({
  toggle: guardedProcedure
    .input(toggleReactionSchema)
    .use(rateLimit(reactionRateLimits))
    .mutation(toggleReactionHandler),
});
