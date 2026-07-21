import { TRPCError } from '@trpc/server';

import {
  deleteUserCommentHandler,
  getCommentCommentsCountHandler,
  getCommentCommentsHandler,
  getCommentHandler,
  getCommentReactionsHandler,
  getCommentsInfiniteHandler,
  setTosViolationHandler,
  toggleHideCommentHandler,
  togglePinCommentHandler,
  toggleLockHandler,
  upsertCommentHandler,
} from '~/server/controllers/comment.controller';
import { toggleReactionHandler } from '~/server/controllers/reaction.controller';
import { dbRead } from '~/server/db/client';
import { rateLimit } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import type { CommentUpsertInput } from '~/server/schema/comment.schema';
import {
  commentRateLimits,
  commentUpsertInput,
  getAllCommentsSchema,
  getCommentCountByModelSchema,
  getCommentReactionsSchema,
  toggleReactionInput,
} from '~/server/schema/comment.schema';
import { getCommentCountByModel } from '~/server/services/comment.service';
import {
  guardedProcedure,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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
  getAll: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getAllCommentsSchema)
    .query(getCommentsInfiniteHandler),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getCommentHandler),
  getReactions: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getCommentReactionsSchema)
    .query(getCommentReactionsHandler),
  getCommentsById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getCommentCommentsHandler),
  getCommentsCount: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(getCommentCommentsCountHandler),
  getCommentCountByModel: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getCommentCountByModelSchema)
    .query(({ input }) => getCommentCountByModel(input)),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(commentUpsertInput)
    .use(isOwnerOrModerator)
    .use(isLocked)
    .use(rateLimit(commentRateLimits))
    .mutation(upsertCommentHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteUserCommentHandler),
  toggleReaction: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleReactionInput)
    .mutation(({ input, ctx }) =>
      toggleReactionHandler({
        ctx,
        input: { entityType: 'commentOld', entityId: input.id, reaction: input.reaction },
      })
    ),
  toggleHide: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(getByIdSchema)
    .mutation(toggleHideCommentHandler),
  togglePin: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(getByIdSchema)
    .mutation(togglePinCommentHandler),
  toggleLock: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(toggleLockHandler),
  setTosViolation: moderatorProcedure.input(getByIdSchema).mutation(setTosViolationHandler),
});
