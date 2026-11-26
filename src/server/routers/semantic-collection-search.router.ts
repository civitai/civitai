import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { semanticCollectionSearchSchema } from '~/server/schema/semantic-collection-search.schema';
import { searchSemanticCollections } from '~/server/services/semantic-collection-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { refuseProfaneSearch } from '~/server/utils/refuse-profane-search';

export const semanticCollectionSearchRouter = router({
  search: publicProcedure
    .use(timeSemanticSearch('collections'))
    .use(isFlagProtected('profileCollections'))
    .use(isFlagProtected('semanticCollectionSearch'))
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticCollectionSearchSchema)
    .use(refuseProfaneSearch)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticCollections({ input, ctx, track: ctx.track });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'collections_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
