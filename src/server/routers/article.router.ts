import {
  router,
  publicProcedure,
  guardedProcedure,
  protectedProcedure,
  isFlagProtected,
} from '~/server/trpc';
import type { UpsertArticleInput } from '~/server/schema/article.schema';
import {
  getInfiniteArticlesSchema,
  upsertArticleInput,
  articleRateLimits,
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
} from '~/server/services/article.service';
import {
  unpublishArticleHandler,
  upsertArticleHandler,
} from '~/server/controllers/article.controller';
import { edgeCacheIt, rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';

export const articleRouter = router({
  getInfinite: publicProcedure
    .input(getInfiniteArticlesSchema)
    .query(({ input, ctx }) =>
      getArticles({ ...input, sessionUser: ctx?.user, include: ['cosmetics'] })
    ),
  getCivitaiNews: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(() => getCivitaiNews()),
  getEvents: publicProcedure.query(() => getCivitaiEvents()),
  getById: publicProcedure
    .input(getByIdSchema)
    .query(({ input, ctx }) =>
      getArticleById({ ...input, userId: ctx.user?.id, isModerator: ctx.user?.isModerator })
    ),
  getMyDraftArticles: protectedProcedure
    .input(getAllQuerySchema)
    .use(isFlagProtected('articles'))
    .query(({ input, ctx }) => getDraftArticlesByUserId({ ...input, userId: ctx.user.id })),
  upsert: guardedProcedure
    .input(upsertArticleInput)
    .use(isFlagProtected('articleCreate'))
    .use(rateLimit(articleRateLimits, (input: UpsertArticleInput) => !input.id))
    .mutation(upsertArticleHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('articleCreate'))
    .mutation(({ input, ctx }) =>
      deleteArticleById({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  unpublish: guardedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('articles'))
    .mutation(unpublishArticleHandler),
  getScanStatus: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('articleImageScanning'))
    .query(({ input }) => getArticleScanStatus(input)),
});
