import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { semanticChallengeSearchSchema } from '~/server/schema/semantic-challenge-search.schema';
import { searchSemanticChallenges } from '~/server/services/semantic-challenge-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { requestDomainBrowsingLevelCap } from '~/server/utils/browsing-level';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const semanticChallengeSearchRouter = router({
  search: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(timeSemanticSearch('challenges'))
    .use(isFlagProtected('challengePlatform'))
    .use(isFlagProtected('semanticChallengeSearch'))
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticChallengeSearchSchema)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticChallenges({
        input,
        user: ctx.user,
        isGreen: !!ctx.features.isGreen,
        canAccessUserChallenges: !!ctx.features.userChallenges,
        browsingLevelCap: requestDomainBrowsingLevelCap(ctx),
        track: ctx.track,
      });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'challenges_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
