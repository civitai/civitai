import { firstPublishCardSchema, legendStatusSchema } from '~/server/schema/creator-journey.schema';
import {
  getCreatorJourney,
  getCreatorScoreLadder,
  getFirstPublishCard,
  getLegendStatus,
} from '~/server/services/creator-journey.service';
import { getCreatorShowcase } from '~/server/services/creator-showcase.service';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const creatorJourneyRouter = router({
  getLadder: publicProcedure
    .use(isFlagProtected('creatorJourney'))
    .query(() => getCreatorScoreLadder()),
  getLegendStatus: publicProcedure
    .use(isFlagProtected('creatorJourney'))
    .input(legendStatusSchema)
    .query(({ input }) => getLegendStatus(input.userId)),
  getShowcase: publicProcedure
    .use(isFlagProtected('creatorJourney'))
    .query(() => getCreatorShowcase()),
  getMine: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(isFlagProtected('creatorJourney'))
    .query(({ ctx }) => getCreatorJourney(ctx.user.id)),
  getFirstPublishCard: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(isFlagProtected('creatorJourney'))
    .input(firstPublishCardSchema)
    .query(({ ctx, input }) => getFirstPublishCard({ ...input, userId: ctx.user.id })),
});
