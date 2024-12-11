import { getByIdSchema } from './../schema/base.schema';
import {
  deleteCommentV2Handler,
  getCommentCountV2Handler,
  getCommentsThreadDetailsHandler,
  getInfiniteCommentsV2Handler,
  toggleLockThreadDetailsHandler,
  upsertCommentV2Handler,
  getCommentHandler,
  toggleHideCommentHandler,
} from './../controllers/commentv2.controller';
import {
  commentConnectorSchema,
  getCommentsV2Schema,
  upsertCommentv2Schema,
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
  getInfinite: publicProcedure.input(getCommentsV2Schema).query(getInfiniteCommentsV2Handler),
  getCount: publicProcedure.input(commentConnectorSchema).query(getCommentCountV2Handler),
  getSingle: publicProcedure.input(getByIdSchema).query(getCommentHandler),
  upsert: guardedProcedure
    .input(upsertCommentv2Schema)
    .use(isOwnerOrModerator)
    .use(rateLimit(commentRateLimits))
    .mutation(upsertCommentV2Handler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteCommentV2Handler),
  getThreadDetails: publicProcedure
    .input(commentConnectorSchema)
    .query(getCommentsThreadDetailsHandler),
  toggleLockThread: moderatorProcedure
    .input(commentConnectorSchema)
    .mutation(toggleLockThreadDetailsHandler),
  toggleHide: protectedProcedure.input(toggleHideCommentSchema).mutation(toggleHideCommentHandler),
});
