import {
  challengeQuickActionSchema,
  checkEntryEligibilitySchema,
  deleteChallengeSchema,
  getChallengeWinnersSchema,
  getInfiniteChallengesSchema,
  getModeratorChallengesSchema,
  getUpcomingThemesSchema,
  getUserEntryCountSchema,
  upsertChallengeSchema,
  updateChallengeConfigSchema,
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
  checkImageEligibility,
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
  getActiveJudges,
  getChallengeSystemConfig,
  updateChallengeSystemConfig,
} from '~/server/services/challenge.service';

// Router definition
export const challengeRouter = router({
  // Get paginated list of challenges
  getInfinite: publicProcedure
    .input(getInfiniteChallengesSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getInfiniteChallenges(input)),

  // Get single challenge by ID (moderators bypass visibility filters)
  getById: publicProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) => getChallengeDetail(input.id, ctx.user?.isModerator)),

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

  // Check image eligibility for a challenge
  checkEntryEligibility: protectedProcedure
    .input(checkEntryEligibilitySchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => checkImageEligibility(input.challengeId, input.imageIds)),

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

  // Moderator: Get active judges for dropdown
  getJudges: moderatorProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(() => getActiveJudges()),

  // Moderator: Get system challenge config
  getSystemConfig: moderatorProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(() => getChallengeSystemConfig()),

  // Moderator: Update system challenge config
  updateSystemConfig: moderatorProcedure
    .input(updateChallengeConfigSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => updateChallengeSystemConfig(input)),

  // Moderator: Delete a challenge
  delete: moderatorProcedure
    .input(deleteChallengeSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => deleteChallenge(input.id)),
});
