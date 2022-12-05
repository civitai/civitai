import { TRPCError } from '@trpc/server';

import {
  deleteUserCommentHandler,
  getCommentHandler,
  getCommentReactionsHandler,
  getCommentsInfiniteHandler,
  reportCommentHandler,
  toggleReactionHandler,
  upsertCommentHandler,
} from '~/server/controllers/comment.controller';
import { prisma } from '~/server/db/client';
import { getByIdSchema, reportInputSchema } from '~/server/schema/base.schema';
import {
  commentUpsertInput,
  getAllCommentsSchema,
  getCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { toggleReactionInput } from '~/server/schema/review.schema';
import { middleware, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

const isOwnerOrModerator = middleware(async ({ ctx, next, input }) => {
  if (!ctx?.user) throw new TRPCError({ code: 'UNAUTHORIZED' });

  const { id } = input as { id: number };
  const userId = ctx.user.id;
  let ownerId: number = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await prisma.comment.findUnique({ where: { id } }))?.userId ?? 0;
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

export const commentRouter = router({
  getAll: publicProcedure.input(getAllCommentsSchema).query(getCommentsInfiniteHandler),
  getById: publicProcedure.input(getByIdSchema).query(getCommentHandler),
  getReactions: publicProcedure.input(getCommentReactionsSchema).query(getCommentReactionsHandler),
  upsert: protectedProcedure
    .input(commentUpsertInput)
    .use(isOwnerOrModerator)
    .mutation(upsertCommentHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteUserCommentHandler),
  report: protectedProcedure.input(reportInputSchema).mutation(reportCommentHandler),
  toggleReaction: protectedProcedure.input(toggleReactionInput).mutation(toggleReactionHandler),
});
