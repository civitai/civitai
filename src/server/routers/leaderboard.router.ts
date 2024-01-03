import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
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

export const leaderboardRouter = router({
  getLeaderboards: publicProcedure.query(({ ctx }) =>
    getLeaderboards({ isModerator: ctx?.user?.isModerator ?? false })
  ),
  getLeaderboardPositions: publicProcedure
    .input(getLeaderboardPositionsSchema)
    .use(
      edgeCacheIt({
        ttl: CacheTTL.day,
        tags: (input) => [
          'leaderboard',
          'leaderboard-positions',
          `leaderboard-positions-${input.userId}`,
        ],
      })
    )
    .query(({ input, ctx }) =>
      getLeaderboardPositions({
        ...input,
        userId: input.userId,
        isModerator: ctx?.user?.isModerator ?? false,
      })
    ),
  getLeaderboard: publicProcedure
    .input(getLeaderboardSchema)
    .use(
      edgeCacheIt({
        ttl: CacheTTL.day,
        tags: (input) => ['leaderboard', `leaderboard-${input.id}`],
      })
    )
    .query(({ input, ctx }) =>
      getLeaderboard({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
  getLeadboardLegends: publicProcedure
    .input(getLeaderboardSchema)
    .use(
      edgeCacheIt({
        ttl: CacheTTL.day,
        tags: (input) => ['leaderboard', `leaderboard-${input.id}`, 'leaderboard-legends'],
      })
    )
    .query(({ input, ctx }) =>
      getLeaderboardLegends({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
});
