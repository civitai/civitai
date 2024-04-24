import { TRPCError } from '@trpc/server';

import {
  deleteUserCommentHandler,
  getCommentCommentsHandler,
  getCommentCommentsCountHandler,
  getCommentHandler,
  getCommentReactionsHandler,
  getCommentsInfiniteHandler,
  setTosViolationHandler,
  toggleLockHandler,
  upsertCommentHandler,
  toggleHideCommentHandler,
} from '~/server/controllers/comment.controller';
import { getCommentCountByModel } from '~/server/services/comment.service';
import { toggleReactionHandler } from '~/server/controllers/reaction.controller';
import { dbRead } from '~/server/db/client';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  CommentUpsertInput,
  commentUpsertInput,
  getAllCommentsSchema,
  getCommentCountByModelSchema,
  getCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { toggleReactionInput } from '~/server/schema/comment.schema';
import {
  guardedProcedure,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { CacheTTL } from '~/server/common/constants';
import { rateLimit } from '~/server/middleware.trpc';

const isOwnerOrModerator = middleware(async ({ ctx, next, input }) => {
  if (!ctx?.user) throw new TRPCError({ code: 'UNAUTHORIZED' });

  const { id } = input as { id: number };
  const userId = ctx.user.id;
  let ownerId: number = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await dbRead.comment.findUnique({ where: { id } }))?.userId ?? 0;
    if (!isModerator && ownerId) {
      if (ownerId !== userId) throw throwAuthorizationError();
    }
  }

  return next({
    ctx: {
      // infers the `session` as non-nullable
      ...ctx,
      user: ctx.user,
      ownerId,
    },
  });
});

const isLocked = middleware(async ({ ctx, next, input }) => {
  if (!ctx?.user) throw new TRPCError({ code: 'UNAUTHORIZED' });

  const isModerator = ctx.user.isModerator;
  if (isModerator)
    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
        locked: false,
      },
    });

  const { id, modelId } = input as CommentUpsertInput;
  const model = await dbRead.model.findUnique({ where: { id: modelId } });
  if (model?.locked) throw new TRPCError({ code: 'FORBIDDEN', message: 'Model is locked' });

  const comment = await dbRead.comment.findFirst({ where: { id } });
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      locked: comment?.locked || false,
    },
  });
});

export const commentRouter = router({
  getAll: publicProcedure.input(getAllCommentsSchema).query(getCommentsInfiniteHandler),
  getById: publicProcedure.input(getByIdSchema).query(getCommentHandler),
  getReactions: publicProcedure.input(getCommentReactionsSchema).query(getCommentReactionsHandler),
  getCommentsById: publicProcedure.input(getByIdSchema).query(getCommentCommentsHandler),
  getCommentsCount: publicProcedure.input(getByIdSchema).query(getCommentCommentsCountHandler),
  getCommentCountByModel: publicProcedure
    .input(getCommentCountByModelSchema)
    .query(({ input }) => getCommentCountByModel(input)),
  upsert: guardedProcedure
    .input(commentUpsertInput)
    .use(isOwnerOrModerator)
    .use(isLocked)
    .use(rateLimit({ limit: 60, period: CacheTTL.hour }))
    .mutation(upsertCommentHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteUserCommentHandler),
  toggleReaction: protectedProcedure.input(toggleReactionInput).mutation(({ input, ctx }) =>
    toggleReactionHandler({
      ctx,
      input: { entityType: 'commentOld', entityId: input.id, reaction: input.reaction },
    })
  ),
  toggleHide: protectedProcedure.input(getByIdSchema).mutation(toggleHideCommentHandler),
  toggleLock: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(toggleLockHandler),
  setTosViolation: moderatorProcedure.input(getByIdSchema).mutation(setTosViolationHandler),
});
