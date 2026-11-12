import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { semanticArticleSearchSchema } from '~/server/schema/semantic-article-search.schema';
import { searchSemanticArticles } from '~/server/services/semantic-article-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';

export const semanticArticleSearchRouter = router({
  search: publicProcedure
    .use(timeSemanticSearch('articles'))
    .use(isFlagProtected('semanticArticleSearch'))
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticArticleSearchSchema)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticArticles({ input, user: ctx.user, track: ctx.track });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'articles_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
