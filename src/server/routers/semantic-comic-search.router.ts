import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { semanticComicSearchSchema } from '~/server/schema/semantic-comic-search.schema';
import { searchSemanticComics } from '~/server/services/semantic-comic-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { requestDomainBrowsingLevelCap } from '~/server/utils/browsing-level';

export const semanticComicSearchRouter = router({
  search: publicProcedure
    .use(timeSemanticSearch('comics'))
    .use(isFlagProtected('semanticComicSearch'))
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticComicSearchSchema)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticComics({
        input,
        user: ctx.user,
        browsingLevelCap: requestDomainBrowsingLevelCap(ctx),
        track: ctx.track,
      });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'comics_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
