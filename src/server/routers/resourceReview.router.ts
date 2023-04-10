import {
  createResourceReviewSchema,
  getRatingTotalsSchema,
  getResourceReviewsInfiniteSchema,
  updateResourceReviewSchema,
  getResourceReviewPagedSchema,
  getUserResourceReviewSchema,
} from './../schema/resourceReview.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  createResourceReviewHandler,
  deleteResourceReviewHandler,
  updateResourceReviewHandler,
  upsertResourceReviewHandler,
} from './../controllers/resourceReview.controller';
import { dbRead } from '~/server/db/client';
import { upsertResourceReviewSchema } from '~/server/schema/resourceReview.schema';
import { middleware, publicProcedure, router, protectedProcedure } from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  getPagedResourceReviews,
  getRatingTotals,
  getResourceReview,
  getResourceReviewsInfinite,
  getUserResourceReview,
  toggleExcludeResourceReview,
} from '~/server/services/resourceReview.service';
import { moderatorProcedure } from '~/server/trpc';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };

  const userId = ctx.user.id;
  let ownerId = userId;
  const isModerator = ctx?.user?.isModerator;
  if (!isModerator && id) {
    ownerId =
      (await dbRead.resourceReview.findUnique({ where: { id }, select: { userId: true } }))
        ?.userId ?? 0;
    if (ownerId !== userId) throw throwAuthorizationError();
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
  get: publicProcedure.input(getByIdSchema).query(({ input }) => getResourceReview(input)),
  getUserResourceReview: protectedProcedure
    .input(getUserResourceReviewSchema)
    .query(({ input, ctx }) => getUserResourceReview({ ...input, userId: ctx.user.id })),
  getInfinite: publicProcedure
    .input(getResourceReviewsInfiniteSchema)
    .query(({ input }) => getResourceReviewsInfinite(input)),
  getPaged: publicProcedure
    .input(getResourceReviewPagedSchema)
    .query(({ input }) => getPagedResourceReviews(input)),
  getRatingTotals: publicProcedure
    .input(getRatingTotalsSchema)
    .query(({ input }) => getRatingTotals(input)),
  upsert: protectedProcedure
    .input(upsertResourceReviewSchema)
    .use(isOwnerOrModerator)
    .mutation(upsertResourceReviewHandler),
  create: protectedProcedure
    .input(createResourceReviewSchema)
    .mutation(createResourceReviewHandler),
  update: protectedProcedure
    .input(updateResourceReviewSchema)
    .use(isOwnerOrModerator)
    .mutation(updateResourceReviewHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteResourceReviewHandler),
  toggleExclude: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input }) => toggleExcludeResourceReview(input)),
});
