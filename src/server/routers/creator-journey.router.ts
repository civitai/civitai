import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
import {
  getCreatorJourney,
  getCreatorScoreLadder,
} from '~/server/services/creator-journey.service';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const creatorJourneyRouter = router({
  getLadder: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(() => getCreatorScoreLadder()),
  getMine: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getCreatorJourney(ctx.user.id)),
});
