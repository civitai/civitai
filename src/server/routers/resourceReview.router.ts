import {
  createResourceReviewSchema,
  getRatingTotalsSchema,
  getResourceReviewsInfiniteSchema,
  updateResourceReviewSchema,
  getRecommendedBySchema,
  getResourceReviewPagedSchema,
  getResourceReviewImagesSchema,
  getUserResourceReviewSchema,
} from './../schema/resourceReview.schema';
import { withMaskedDetails } from '~/server/services/profanity-mask.service';
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
  getRecommendedBy,
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
    .query(async ({ input, ctx }) => {
      const review = await getResourceReview({
        ...input,
        userId: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
      });
      const [masked] = await withMaskedDetails([review]);
      return masked;
    }),
  getUserResourceReview: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getUserResourceReviewSchema)
    .query(async ({ input, ctx }) => {
      const reviews = await getUserResourceReview({ ...input, userId: ctx.user.id });
      return reviews ? withMaskedDetails(reviews) : reviews;
    }),
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getResourceReviewsInfiniteSchema)
    .query(async ({ input, ctx }) => {
      const page = await getResourceReviewsInfinite({ ...input, viewerId: ctx.user?.id });
      return { ...page, items: await withMaskedDetails(page.items) };
    }),
  getPaged: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getResourceReviewPagedSchema)
    .query(async ({ input, ctx }) => {
      const page = await getPagedResourceReviews({ input, userId: ctx.user?.id });
      return { ...page, items: await withMaskedDetails(page.items) };
    }),
  getRecommendedBy: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getRecommendedBySchema)
    .query(({ input, ctx }) => getRecommendedBy({ input, userId: ctx.user?.id })),
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
