import dayjs from 'dayjs';
import { edgeCacheIt } from '~/server/middleware.trpc';
import {
  getLeaderboardPositionsSchema,
  getLeaderboardSchema,
} from '~/server/schema/leaderboard.schema';
import {
  getLeaderboard,
  getLeaderboards,
  getLeaderboardPositions,
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
        ttl: false,
        tags: (input) => ['leaderboard', `leaderboard-positions-${input.userId}`],
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
        ttl: false,
        tags: (input) => ['leaderboard', `leaderboard-${input.id}`],
      })
    )
    .query(({ input, ctx }) =>
      getLeaderboard({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
});
