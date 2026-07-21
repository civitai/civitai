import { getByIdSchema } from './../schema/base.schema';
import {
  deleteCommentV2Handler,
  getCommentCountV2Handler,
  getCommentsThreadDetailsHandler,
  getCommentsInfiniteHandler,
  toggleLockThreadDetailsHandler,
  upsertCommentV2Handler,
  getCommentHandler,
  toggleHideCommentHandler,
  togglePinnedCommentHandler,
} from './../controllers/commentv2.controller';
import {
  commentConnectorSchema,
  upsertCommentv2Schema,
  getCommentsInfiniteSchema,
} from './../schema/commentv2.schema';
import {
  middleware,
  router,
  publicProcedure,
  protectedProcedure,
  guardedProcedure,
  moderatorProcedure,
} from '~/server/trpc';
import { dbRead } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { toggleHideCommentSchema } from '~/server/schema/commentv2.schema';
import { rateLimit } from '~/server/middleware.trpc';
import { commentRateLimits } from '~/server/schema/comment.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;
  if (!isModerator && !!id) {
    const ownerId = (await dbRead.commentV2.findUnique({ where: { id } }))?.userId ?? 0;
    if (ownerId !== userId) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
    },
  });
});

export const commentv2Router = router({
  getCount: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(commentConnectorSchema)
    .query(getCommentCountV2Handler),
  getSingle: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getCommentHandler),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(upsertCommentv2Schema)
    .use(isOwnerOrModerator)
    .use(rateLimit(commentRateLimits))
    .mutation(upsertCommentV2Handler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteCommentV2Handler),
  getThreadDetails: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(commentConnectorSchema)
    .query(getCommentsThreadDetailsHandler),
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getCommentsInfiniteSchema)
    .query(getCommentsInfiniteHandler),
  toggleLockThread: moderatorProcedure
    .input(commentConnectorSchema)
    .mutation(toggleLockThreadDetailsHandler),
  toggleHide: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleHideCommentSchema)
    .mutation(toggleHideCommentHandler),
  togglePinned: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleHideCommentSchema)
    .mutation(togglePinnedCommentHandler),
});
