import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';
import { rateLimit } from '~/server/middleware.trpc';
import { semanticStorylineSearchSchema } from '~/server/schema/semantic-storyline-search.schema';
import { searchSemanticStorylines } from '~/server/services/semantic-storyline-search.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { storylineReaderLevel } from '~/server/utils/storyline-reader-level';

export const semanticStorylineSearchRouter = router({
  search: publicProcedure
    .use(timeSemanticSearch('storylines'))
    .use(isFlagProtected('storylines'))
    .use(isFlagProtected('semanticStorylineSearch'))
    // Signed-out visitors share an IP bucket, so theirs is lower.
    .use(
      rateLimit([
        { limit: 20, period: 60 },
        { limit: 60, period: 60, userReq: () => true },
      ])
    )
    .input(semanticStorylineSearchSchema)
    .query(async ({ input, ctx }) => {
      const started = Date.now();
      const result = await searchSemanticStorylines({
        input: { ...input, browsingLevel: storylineReaderLevel(ctx, input.browsingLevel) },
        user: ctx.user,
        track: ctx.track,
      });
      const latencyMs = Date.now() - started;

      if (!input.cursor) {
        const { query, cursor, limit, ...filters } = input;
        void ctx.track
          .search({
            query,
            index: 'storylines_semantic',
            filters: { ...filters, resultCount: result.items.length, latencyMs },
          })
          .catch(() => undefined);
      }

      return { ...result, latencyMs };
    }),
});
