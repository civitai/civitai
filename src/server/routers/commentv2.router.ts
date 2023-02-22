import { getByIdSchema } from './../schema/base.schema';
import {
  deleteCommentV2Handler,
  getCommentCountV2Handler,
  getCommentsThreadDetailsHandler,
  getInfiniteCommentsV2Handler,
  toggleLockThreadDetailsHandler,
  upsertCommentV2Handler,
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
} from '~/server/trpc';
import { dbRead } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await dbRead.commentV2.findUnique({ where: { id } }))?.userId ?? 0;
    if (!isModerator) {
      if (ownerId !== userId) throw throwAuthorizationError();
    }
  }

  return next({
    ctx: {
      // infers the `user` as non-nullable
      user: ctx.user,
      ownerId,
    },
  });
});

const isModerator = middleware(async ({ ctx, next }) => {
  if (!ctx.user?.isModerator) throw throwAuthorizationError();
  return next({
    ctx: {
      user: ctx.user,
    },
  });
});

export const commentv2Router = router({
  getInfinite: publicProcedure.input(getCommentsV2Schema).query(getInfiniteCommentsV2Handler),
  getCount: publicProcedure.input(commentConnectorSchema).query(getCommentCountV2Handler),
  upsert: guardedProcedure
    .input(upsertCommentv2Schema)
    .use(isOwnerOrModerator)
    .mutation(upsertCommentV2Handler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteCommentV2Handler),
  getThreadDetails: publicProcedure
    .input(commentConnectorSchema)
    .query(getCommentsThreadDetailsHandler),
  toggleLockThread: protectedProcedure
    .input(commentConnectorSchema)
    .use(isModerator)
    .mutation(toggleLockThreadDetailsHandler),
});
