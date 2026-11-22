import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { refuseProfaneSearch } from '~/server/utils/refuse-profane-search';
import { semanticBountySearchSchema } from '~/server/schema/semantic-bounty-search.schema';
import { searchSemanticBounties } from '~/server/services/semantic-bounty-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';

export const semanticBountySearchRouter = router({
  search: publicProcedure
    .use(timeSemanticSearch('bounties'))
    .use(isFlagProtected('bounties'))
    .use(isFlagProtected('semanticBountySearch'))
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticBountySearchSchema)
    .use(refuseProfaneSearch)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticBounties({ input, ctx, track: ctx.track });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'bounties_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
