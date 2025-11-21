import {
  router,
  publicProcedure,
  guardedProcedure,
  protectedProcedure,
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
  restoreArticleHandler,
} from '~/server/controllers/article.controller';
import { edgeCacheIt, rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { isModerator } from '~/server/routers/base.router';

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
  unpublish: protectedProcedure
    .input(unpublishArticleSchema)
    .use(isFlagProtected('articles'))
    .use(isOwnerOrModerator)
    .mutation(unpublishArticleHandler),
  restore: protectedProcedure
    .input(restoreArticleSchema)
    .use(isFlagProtected('articles'))
    .use(isModerator)
    .mutation(restoreArticleHandler),
  getScanStatus: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('articleImageScanning'))
    .query(({ input }) => getArticleScanStatus(input)),
});
