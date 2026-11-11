import {
  createResourceReviewSchema,
  getRatingTotalsSchema,
  getResourceReviewsInfiniteSchema,
  updateResourceReviewSchema,
  getResourceReviewPagedSchema,
  getResourceReviewImagesSchema,
  getUserResourceReviewSchema,
} from './../schema/resourceReview.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  createResourceReviewHandler,
  deleteResourceReviewHandler,
  getResourceReviewImagesHandler,
  getUserRatingTotalHandler,
  toggleExcludeResourceReviewHandler,
  updateResourceReviewHandler,
  upsertResourceReviewHandler,
} from './../controllers/resourceReview.controller';
import { dbRead } from '~/server/db/client';
import { upsertResourceReviewSchema } from '~/server/schema/resourceReview.schema';
import {
  middleware,
  publicProcedure,
  router,
  protectedProcedure,
  guardedProcedure,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  getPagedResourceReviews,
  getRatingTotals,
  getResourceReview,
  getResourceReviewsInfinite,
  getUserResourceReview,
} from '~/server/services/resourceReview.service';
import { moderatorProcedure } from '~/server/trpc';
import { getByUsernameSchema } from '~/server/schema/user.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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
  get: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) =>
      getResourceReview({ ...input, userId: ctx.user?.id, isModerator: ctx.user?.isModerator })
    ),
  getUserResourceReview: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getUserResourceReviewSchema)
    .query(({ input, ctx }) => getUserResourceReview({ ...input, userId: ctx.user.id })),
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getResourceReviewsInfiniteSchema)
    .query(({ input, ctx }) => getResourceReviewsInfinite({ ...input, viewerId: ctx.user?.id })),
  getPaged: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getResourceReviewPagedSchema)
    .query(({ input, ctx }) => getPagedResourceReviews({ input, userId: ctx.user?.id })),
  getImages: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getResourceReviewImagesSchema)
    .query(getResourceReviewImagesHandler),
  getRatingTotals: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getRatingTotalsSchema)
    .query(({ input }) => getRatingTotals(input)),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(upsertResourceReviewSchema)
    .use(isOwnerOrModerator)
    .mutation(upsertResourceReviewHandler),
  create: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(createResourceReviewSchema)
    .mutation(createResourceReviewHandler),
  update: guardedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(updateResourceReviewSchema)
    .use(isOwnerOrModerator)
    .mutation(updateResourceReviewHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteResourceReviewHandler),
  toggleExclude: moderatorProcedure
    .input(getByIdSchema)
    .mutation(toggleExcludeResourceReviewHandler),
  getUserRatingsTotal: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByUsernameSchema)
    .query(getUserRatingTotalHandler),
});
