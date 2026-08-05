import { CacheTTL } from '~/server/common/constants';
import { applyRequestBoardDomainColor, cacheIt, edgeCacheIt } from '~/server/middleware.trpc';
import type { GetLeaderboardInput } from '~/server/schema/leaderboard.schema';
import {
  getLeaderboardPositionsSchema,
  getLeaderboardSchema,
  getLeaderboardsSchema,
} from '~/server/schema/leaderboard.schema';
import {
  getLeaderboard,
  getLeaderboards,
  getLeaderboardPositions,
  getLeaderboardLegends,
} from '~/server/services/leaderboard.service';
import { publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const leaderboardEdgeCache = edgeCacheIt({
  ttl: CacheTTL.xs,
});

// `applyRequestDomainColor` must be `.use()`d BEFORE `cacheIt` on every procedure
// here: cacheIt hashes the input to build its Redis key, so a domain stamped
// after it would leave one entry shared across colors.
export const leaderboardRouter = router({
  getLeaderboards: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getLeaderboardsSchema.pick({ domain: true }).default({}))
    .use(applyRequestBoardDomainColor)
    .query(({ input, ctx }) =>
      getLeaderboards({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
  getLeaderboardPositions: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getLeaderboardPositionsSchema)
    .use(applyRequestBoardDomainColor)
    .use(cacheIt({ ttl: CacheTTL.day, tags: () => ['leaderboard', 'leaderboard-positions'] }))
    .query(({ input, ctx }) =>
      getLeaderboardPositions({
        ...input,
        userId: input.userId,
        isModerator: ctx?.user?.isModerator ?? false,
      })
    ),
  getLeaderboard: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getLeaderboardSchema)
    .use(applyRequestBoardDomainColor)
    .use(
      cacheIt({
        ttl: CacheTTL.day,
        tags: (input: GetLeaderboardInput) => ['leaderboard', `leaderboard-${input.id}`],
      })
    )
    .use(leaderboardEdgeCache)
    .query(({ input, ctx }) =>
      getLeaderboard({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
  getLeadboardLegends: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getLeaderboardSchema)
    .use(applyRequestBoardDomainColor)
    .use(
      cacheIt({
        ttl: CacheTTL.day,
        tags: (input: GetLeaderboardInput) => [
          'leaderboard',
          `leaderboard-${input.id}`,
          `leaderboard-${input.id}-legends`,
        ],
      })
    )
    .use(leaderboardEdgeCache)
    .query(({ input, ctx }) =>
      getLeaderboardLegends({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
});
