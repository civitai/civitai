import { CacheTTL } from '~/server/common/constants';
import { cacheIt, edgeCacheIt } from '~/server/middleware.trpc';
import {
  getLeaderboardPositionsSchema,
  getLeaderboardSchema,
} from '~/server/schema/leaderboard.schema';
import {
  getLeaderboard,
  getLeaderboards,
  getLeaderboardPositions,
  getLeaderboardLegends,
} from '~/server/services/leaderboard.service';
import { publicProcedure, router } from '~/server/trpc';

const leaderboardCache = cacheIt({
  ttl: CacheTTL.day,
  tags: () => ['leaderboard'],
});
const leaderboardEdgeCache = edgeCacheIt({
  ttl: CacheTTL.xs,
});

export const leaderboardRouter = router({
  getLeaderboards: publicProcedure.query(({ ctx }) =>
    getLeaderboards({ isModerator: ctx?.user?.isModerator ?? false })
  ),
  getLeaderboardPositions: publicProcedure
    .input(getLeaderboardPositionsSchema)
    .use(leaderboardCache)
    .query(({ input, ctx }) =>
      getLeaderboardPositions({
        ...input,
        userId: input.userId,
        isModerator: ctx?.user?.isModerator ?? false,
      })
    ),
  getLeaderboard: publicProcedure
    .input(getLeaderboardSchema)
    .use(leaderboardCache)
    .use(leaderboardEdgeCache)
    .query(({ input, ctx }) =>
      getLeaderboard({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
  getLeadboardLegends: publicProcedure
    .input(getLeaderboardSchema)
    .use(leaderboardCache)
    .use(leaderboardEdgeCache)
    .query(({ input, ctx }) =>
      getLeaderboardLegends({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
});
