import { toggleReactionHandler } from './../controllers/reaction.controller';
import { toggleReactionSchema, reactionRateLimits } from './../schema/reaction.schema';
import { router, guardedProcedure } from '~/server/trpc';
import { rateLimit } from '~/server/middleware.trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const reactionRouter = router({
  toggle: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleReactionSchema)
    .use(rateLimit(reactionRateLimits))
    // Must stay awaited: the handler backgrounds its slow work (rewards, notifications)
    // internally. Detaching the whole handler dropped the toggle write on pod drain and
    // returned a null payload.
    .mutation(toggleReactionHandler),
});
