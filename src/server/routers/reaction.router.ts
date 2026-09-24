import { toggleReactionHandler } from './../controllers/reaction.controller';
import {
  getMyImageReactionsSchema,
  toggleReactionSchema,
  reactionRateLimits,
} from './../schema/reaction.schema';
import { getUserReactionsForImages } from '~/server/services/image.service';
import { getImageReactors } from '~/server/services/image-reactors.service';
import { getByIdSchema } from '~/server/schema/base.schema';
import { router, guardedProcedure, protectedProcedure } from '~/server/trpc';
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
  /**
   * The viewer's own reactions for image ids they have already been handed.
   *
   * 🔴 This exists because `home-block.getHomeBlock` CANNOT carry them. That response is stored
   * in one Redis entry with no user segment AND served through `edgeCacheIt`, and `canCache`
   * does not turn off for a signed-in viewer — so a per-viewer field on it would be handed to
   * whoever asked next. Hydrating on the client is the only lane, not the lazy one.
   *
   * `protectedProcedure`, not public-returning-empty: an empty result is indistinguishable from
   * "you have reacted to none of these", which is the precise state that gets a viewer to click
   * their own reaction off.
   */
  getMyImageReactions: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getMyImageReactionsSchema)
    .query(({ input, ctx }) =>
      getUserReactionsForImages({ imageIds: input.imageIds, userId: ctx.user.id })
    ),
  /** Owner-only: anyone else gets NOT_FOUND, the same as a missing image. Reactor identities are never public. */
  getImageReactors: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) => getImageReactors({ imageId: input.id, userId: ctx.user.id })),
});
