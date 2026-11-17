import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { semanticCrucibleSearchSchema } from '~/server/schema/semantic-crucible-search.schema';
import { searchSemanticCrucibles } from '~/server/services/semantic-crucible-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { requestDomainBrowsingLevelCap } from '~/server/utils/browsing-level';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const semanticCrucibleSearchRouter = router({
  search: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(timeSemanticSearch('crucibles'))
    .use(isFlagProtected('crucible'))
    .use(isFlagProtected('semanticCrucibleSearch'))
    // Signed-out visitors share an IP bucket, hence the lower limit.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticCrucibleSearchSchema)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticCrucibles({
        input,
        user: ctx.user,
        isGreen: !!ctx.features.isGreen,
        browsingLevelCap: requestDomainBrowsingLevelCap(ctx),
        track: ctx.track,
      });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'crucibles_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
