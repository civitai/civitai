import {
  getRatingTotalsSchema,
  getResourceReviewsInfinite,
} from './../schema/resourceReview.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteResourceReviewHandler,
  getRatingTotalsHandler,
  getResourceReviewsInfiniteHandler,
  upsertResourceReviewHandler,
} from './../controllers/resourceReview.controller';
import { getResourceReviewsHandler } from '~/server/controllers/resourceReview.controller';
import { dbRead } from '~/server/db/client';
import {
  getResourceReviewsSchema,
  upsertResourceReviewSchema,
} from '~/server/schema/resourceReview.schema';
import { middleware, publicProcedure, router, protectedProcedure } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  if (id) {
    const isModerator = ctx?.user?.isModerator;
    ownerId =
      (await dbRead.resourceReview.findUnique({ where: { id }, select: { userId: true } }))
        ?.userId ?? 0;
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

export const resourceReviewRouter = router({
  // getResources: publicProcedure.input(getResourceReviewsSchema).query(getResourceReviewsHandler),
  getInfinite: publicProcedure
    .input(getResourceReviewsInfinite)
    .query(getResourceReviewsInfiniteHandler),
  getRatingTotals: publicProcedure.input(getRatingTotalsSchema).query(getRatingTotalsHandler),
  upsert: protectedProcedure
    .input(upsertResourceReviewSchema)
    .use(isOwnerOrModerator)
    .mutation(upsertResourceReviewHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteResourceReviewHandler),
});
