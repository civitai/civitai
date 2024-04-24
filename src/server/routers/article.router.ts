import {
  router,
  publicProcedure,
  guardedProcedure,
  protectedProcedure,
  isFlagProtected,
} from '~/server/trpc';
import { getInfiniteArticlesSchema, upsertArticleInput } from '~/server/schema/article.schema';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteArticleById,
  getAllArticlesForImageProcessing,
  getArticleById,
  getArticles,
  getCivitaiEvents,
  getCivitaiNews,
  getDraftArticlesByUserId,
} from '~/server/services/article.service';
import { upsertArticleHandler } from '~/server/controllers/article.controller';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';

export const articleRouter = router({
  getInfinite: publicProcedure
    .input(getInfiniteArticlesSchema)
    .use(isFlagProtected('articles'))
    .query(({ input, ctx }) =>
      getArticles({ ...input, sessionUser: ctx?.user, include: ['cosmetics'] })
    ),
  getCivitaiNews: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(() => getCivitaiNews()),
  getEvents: publicProcedure.query(() => getCivitaiEvents()),
  getById: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('articles'))
    .query(({ input, ctx }) => getArticleById({ ...input, user: ctx.user })),
  getMyDraftArticles: protectedProcedure
    .input(getAllQuerySchema)
    .use(isFlagProtected('articles'))
    .query(({ input, ctx }) => getDraftArticlesByUserId({ ...input, userId: ctx.user.id })),
  upsert: guardedProcedure
    .input(upsertArticleInput)
    .use(isFlagProtected('articleCreate'))
    .mutation(upsertArticleHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('articleCreate'))
    .mutation(({ input, ctx }) =>
      deleteArticleById({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  getAllForImageProcessing: protectedProcedure.query(() => getAllArticlesForImageProcessing()),
});
