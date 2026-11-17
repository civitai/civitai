import { modelFeedQueryOptions } from '~/server/controllers/model.controller';
import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { semanticModelSearchSchema } from '~/server/schema/semantic-model-search.schema';
import { searchSemanticModels } from '~/server/services/semantic-model-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';

export const semanticModelSearchRouter = router({
  search: publicProcedure
    .use(timeSemanticSearch('models'))
    .use(isFlagProtected('modelFeedSearch'))
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticModelSearchSchema)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticModels({
        input,
        user: ctx.user,
        queryOptions: await modelFeedQueryOptions(ctx),
        track: ctx.track,
        // As model.getAll: rows that depend on who asked are never cached for another viewer.
        onViewerDependent: () => (ctx.cache.canCache = false),
      });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'models_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
