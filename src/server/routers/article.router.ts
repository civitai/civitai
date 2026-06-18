import {
  router,
  publicProcedure,
  guardedProcedure,
  protectedProcedure,
  moderatorProcedure,
  isFlagProtected,
  middleware,
} from '~/server/trpc';
import type { UpsertArticleInput } from '~/server/schema/article.schema';
import {
  getInfiniteArticlesSchema,
  upsertArticleInput,
  articleRateLimits,
  unpublishArticleSchema,
  restoreArticleSchema,
  createArticleRatingReviewSchema,
  getMyArticleRatingReviewSchema,
  getArticleRatingReviewsSchema,
  resolveArticleRatingReviewSchema,
} from '~/server/schema/article.schema';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteArticleById,
  getArticleById,
  getArticles,
  getArticleScanStatus,
  getCivitaiEvents,
  getCivitaiNews,
  getDraftArticlesByUserId,
  rescanArticle,
  createArticleRatingReview,
  getArticleRatingReviewForOwner,
  getArticleRatingReviews,
  resolveArticleRatingReview,
} from '~/server/services/article.service';
import {
  unpublishArticleHandler,
  upsertArticleHandler,
  restoreArticleHandler,
} from '~/server/controllers/article.controller';
import { edgeCacheIt, rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { isModerator } from '~/server/routers/base.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };
  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;

  if (!isModerator && !!id) {
    const ownerId = (await dbRead.article.findUnique({ where: { id }, select: { userId: true } }))
      ?.userId;
    if (ownerId !== userId) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      user: ctx.user,
    },
  });
});

export const articleRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getInfiniteArticlesSchema)
    .query(({ input, ctx }) =>
      getArticles({ ...input, sessionUser: ctx?.user, include: ['cosmetics'] })
    ),
  getCivitaiNews: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(() => getCivitaiNews()),
  getEvents: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .query(() => getCivitaiEvents()),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getByIdSchema)
    .query(({ input, ctx }) =>
      getArticleById({
        ...input,
        userId: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
      })
    ),
  getMyDraftArticles: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getAllQuerySchema)
    .use(isFlagProtected('articles'))
    .query(({ input, ctx }) => getDraftArticlesByUserId({ ...input, userId: ctx.user.id })),
  upsert: guardedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(upsertArticleInput)
    .use(isFlagProtected('articleCreate'))
    .use(
      rateLimit(articleRateLimits, (input: UpsertArticleInput) => !input.id, {
        onlyCountSuccess: true,
      })
    )
    .mutation(upsertArticleHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesDelete })
    .input(getByIdSchema)
    .use(isFlagProtected('articleCreate'))
    .mutation(async ({ input, ctx }) => {
      const result = await deleteArticleById({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });
      await ctx.track.article({ type: 'Delete', articleId: input.id, nsfw: false });
      return result;
    }),
  unpublish: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(unpublishArticleSchema)
    .use(isFlagProtected('articles'))
    .use(isOwnerOrModerator)
    .mutation(unpublishArticleHandler),
  restore: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(restoreArticleSchema)
    .use(isFlagProtected('articles'))
    .use(isModerator)
    .mutation(restoreArticleHandler),
  rescan: protectedProcedure
    .meta({ requiredScope: TokenScope.ArticlesWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('articleImageScanning'))
    .use(isOwnerOrModerator)
    .mutation(({ input, ctx }) => rescanArticle({ ...input, isModerator: ctx.user.isModerator })),
  getScanStatus: publicProcedure
    .meta({ requiredScope: TokenScope.ArticlesRead })
    .input(getByIdSchema)
    .use(isFlagProtected('articleImageScanning'))
    .query(({ input }) => getArticleScanStatus(input)),
  createRatingReview: protectedProcedure
    .use(isFlagProtected('articleRatingDispute'))
    .input(createArticleRatingReviewSchema)
    .mutation(async ({ input, ctx }) => {
      const review = await createArticleRatingReview({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      });
      // Fire-and-forget: Tracker.send is already non-blocking, but `await`
      // still waits on session resolution. Skip the await so a slow CH
      // session lookup can't add latency to the user-facing mutation.
      ctx.track
        .articleRatingReview({
          articleId: review.articleId,
          fromLevel: review.currentLevel,
          toLevel: review.suggestedLevel,
          hasComment: !!review.userComment,
        })
        .catch(() => undefined);
      return review;
    }),
  getMyArticleRatingReview: protectedProcedure
    .use(isFlagProtected('articleRatingDispute'))
    .input(getMyArticleRatingReviewSchema)
    .query(({ input, ctx }) =>
      getArticleRatingReviewForOwner({ articleId: input.articleId, userId: ctx.user.id })
    ),
  getRatingReviews: moderatorProcedure
    .use(isFlagProtected('articleRatingDispute'))
    .input(getArticleRatingReviewsSchema)
    .query(({ input }) => getArticleRatingReviews(input)),
  resolveRatingReview: moderatorProcedure
    .use(isFlagProtected('articleRatingDispute'))
    .input(resolveArticleRatingReviewSchema)
    .mutation(async ({ input, ctx }) => {
      const result = await resolveArticleRatingReview({
        ...input,
        moderatorId: ctx.user.id,
      });
      // Fire-and-forget — see note on createRatingReview above.
      ctx.track
        .articleRatingReviewResolved({
          reviewId: result.reviewId,
          articleId: result.articleId,
          status: result.status,
          appliedLevel: result.appliedLevel,
          moderatorId: ctx.user.id,
        })
        .catch(() => undefined);
      return result;
    }),
});
