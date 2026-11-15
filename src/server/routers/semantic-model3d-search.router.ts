import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { semanticModel3DSearchSchema } from '~/server/schema/semantic-model3d-search.schema';
import { searchSemanticModels3D } from '~/server/services/semantic-model3d-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';

export const semanticModel3DSearchRouter = router({
  search: publicProcedure
    .use(timeSemanticSearch('models3d'))
    .use(isFlagProtected('semanticModel3DSearch'))
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticModel3DSearchSchema)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticModels3D({ input, user: ctx.user, track: ctx.track });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'models3d_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
