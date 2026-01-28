import {
  challengeQuickActionSchema,
  deleteChallengeSchema,
  getChallengeWinnersSchema,
  getInfiniteChallengesSchema,
  getModeratorChallengesSchema,
  getUpcomingThemesSchema,
  getUserEntryCountSchema,
  upsertChallengeSchema,
} from '~/server/schema/challenge.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import {
  deleteChallenge,
  endChallengeAndPickWinners,
  getChallengeDetail,
  getChallengeWinners,
  getInfiniteChallenges,
  getModeratorChallenges,
  getUpcomingThemes,
  getUserEntryCount,
  upsertChallenge,
  voidChallenge,
} from '~/server/services/challenge.service';

// Router definition
export const challengeRouter = router({
  // Get paginated list of challenges
  getInfinite: publicProcedure
    .input(getInfiniteChallengesSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getInfiniteChallenges(input)),

  // Get single challenge by ID
  getById: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getChallengeDetail(input.id)),

  // Get upcoming challenge themes for preview widget
  getUpcomingThemes: publicProcedure
    .input(getUpcomingThemesSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getUpcomingThemes(input.count)),

  // Get challenge winners
  getWinners: publicProcedure
    .input(getChallengeWinnersSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getChallengeWinners(input.challengeId)),

  // Get current user's entry count for a challenge
  getUserEntryCount: protectedProcedure
    .input(getUserEntryCountSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) => getUserEntryCount(input.challengeId, ctx.user.id)),

  // Moderator: Get all challenges (including drafts)
  getModeratorList: moderatorProcedure
    .input(getModeratorChallengesSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getModeratorChallenges(input)),

  // Moderator: Create or update a challenge
  upsert: moderatorProcedure
    .input(upsertChallengeSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input, ctx }) => upsertChallenge({ ...input, userId: ctx.user.id })),

  // Moderator: End challenge early and pick winners
  endAndPickWinners: moderatorProcedure
    .input(challengeQuickActionSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => endChallengeAndPickWinners(input.id)),

  // Moderator: Void/cancel a challenge without picking winners
  voidChallenge: moderatorProcedure
    .input(challengeQuickActionSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => voidChallenge(input.id)),

  // Moderator: Delete a challenge
  delete: moderatorProcedure
    .input(deleteChallengeSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => deleteChallenge(input.id)),
});
