import { TRPCError } from '@trpc/server';
import {
  deleteUserReviewHandler,
  getReviewReactionsHandler,
  getReviewsInfiniteHandler,
  reportReviewHandler,
  toggleReactionHandler,
  upsertReviewHandler,
} from './../controllers/review.controller';
import {
  getAllReviewSchema,
  getReviewReactionsSchema,
  toggleReactionInput,
} from './../schema/review.schema';

import { middleware, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { reviewUpsertSchema } from '~/server/schema/review.schema';
import { prisma } from '~/server/db/client';
import { getByIdSchema, reportInputSchema } from '~/server/schema/base.schema';

const isOwnerOrModerator = middleware(async ({ ctx, next, input }) => {
  if (!ctx?.user) throw new TRPCError({ code: 'UNAUTHORIZED' });

  const { id } = input as { id: number };
  const userId = ctx.user.id;
  let ownerId: number = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId = (await prisma.review.findUnique({ where: { id } }))?.userId ?? 0;
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

export const reviewRouter = router({
  getAll: publicProcedure.input(getAllReviewSchema).query(getReviewsInfiniteHandler),
  getReactions: publicProcedure.input(getReviewReactionsSchema).query(getReviewReactionsHandler),
  upsert: protectedProcedure
    .input(reviewUpsertSchema)
    .use(isOwnerOrModerator)
    .mutation(upsertReviewHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteUserReviewHandler),
  report: protectedProcedure.input(reportInputSchema).mutation(reportReviewHandler),
  toggleReaction: protectedProcedure.input(toggleReactionInput).mutation(toggleReactionHandler),
});
