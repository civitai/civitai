import {
  firstPublishCardSchema,
  legendStatusSchema,
  milestoneShareSchema,
  profileAchievementsSchema,
} from '~/server/schema/creator-journey.schema';
import {
  getCreatorJourney,
  getCreatorScoreLadder,
  getFirstPublishCard,
  getLegendStatus,
  getProfileAchievements,
} from '~/server/services/creator-journey.service';
import { getCreatorShowcase } from '~/server/services/creator-showcase.service';
import {
  getMilestoneShareStates,
  isMilestoneShareable,
} from '~/server/services/creator-milestone-share.service';
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
  getProfileAchievements: publicProcedure
    .use(isFlagProtected('creatorJourney'))
    .input(profileAchievementsSchema)
    .query(({ input, ctx }) => getProfileAchievements({ ...input, viewerId: ctx.user?.id })),
  getShowcase: publicProcedure
    .use(isFlagProtected('creatorJourney'))
    .query(() => getCreatorShowcase()),
  // Not flag-protected: the viewer is usually a crawler. The owner's flag is checked inside.
  isMilestoneShareable: publicProcedure
    .input(milestoneShareSchema)
    .query(({ input }) => isMilestoneShareable(input)),
  getMine: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(isFlagProtected('creatorJourney'))
    .query(async ({ ctx }) => {
      const [journey, share] = await Promise.all([
        getCreatorJourney(ctx.user.id),
        // Share buttons are extras: an unreadable share rule hides them, never the journey.
        getMilestoneShareStates(ctx.user.id).catch(() => ({
          shareable: [] as string[],
          hiddenOnProfile: [] as string[],
          secret: [] as string[],
        })),
      ]);
      return { ...journey, share };
    }),
  getMyShareStates: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(isFlagProtected('creatorJourney'))
    .query(({ ctx }) => getMilestoneShareStates(ctx.user.id)),
  getFirstPublishCard: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(isFlagProtected('creatorJourney'))
    .input(firstPublishCardSchema)
    .query(({ ctx, input }) => getFirstPublishCard({ ...input, userId: ctx.user.id })),
});
