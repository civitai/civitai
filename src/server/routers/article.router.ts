import { router, publicProcedure, guardedProcedure, protectedProcedure } from '~/server/trpc';
import { getInfiniteArticlesSchema, upsertArticleInput } from '~/server/schema/article.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteArticleById,
  getArticleById,
  getArticles,
  getArticlesByCategory,
  upsertArticle,
} from '~/server/services/article.service';

export const articleRouter = router({
  getInfinite: publicProcedure
    .input(getInfiniteArticlesSchema)
    .query(({ input, ctx }) => getArticles({ ...input, user: ctx?.user })),
  getByCategory: publicProcedure
    .input(getInfiniteArticlesSchema)
    .query(({ input, ctx }) => getArticlesByCategory({ ...input, user: ctx?.user })),
  getById: publicProcedure.input(getByIdSchema).query(({ input }) => getArticleById(input)),
  upsert: guardedProcedure
    .input(upsertArticleInput)
    .mutation(({ input, ctx }) => upsertArticle({ ...input, userId: ctx.user.id })),
  delete: protectedProcedure.input(getByIdSchema).mutation(({ input }) => deleteArticleById(input)),
});
