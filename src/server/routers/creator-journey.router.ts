import {
  getCreatorJourney,
  getCreatorScoreLadder,
} from '~/server/services/creator-journey.service';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const creatorJourneyRouter = router({
  getLadder: publicProcedure
    .use(isFlagProtected('creatorJourney'))
    .query(() => getCreatorScoreLadder()),
  getMine: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(isFlagProtected('creatorJourney'))
    .query(({ ctx }) => getCreatorJourney(ctx.user.id)),
});
