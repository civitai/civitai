import {
  challengeQuickActionSchema,
  checkEntryEligibilitySchema,
  deleteChallengeSchema,
  getChallengeEventsSchema,
  getChallengeWinnersSchema,
  getInfiniteChallengesSchema,
  getModeratorChallengesSchema,
  getUpcomingThemesSchema,
  getUserEntryCountSchema,
  upsertChallengeSchema,
  upsertChallengeEventSchema,
  updateChallengeConfigSchema,
  getJudgeByIdSchema,
  upsertJudgeSchema,
  playgroundGenerateContentSchema,
  playgroundReviewImageSchema,
  playgroundPickWinnersSchema,
} from '~/server/schema/challenge.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import { z } from 'zod';
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
  deleteChallengeEvent,
  endChallengeAndPickWinners,
  getActiveEvents,
  getChallengeDetail,
  getChallengeEvents,
  getChallengeWinners,
  getInfiniteChallenges,
  getModeratorChallenges,
  getUpcomingThemes,
  getUserEntryCount,
  upsertChallenge,
  upsertChallengeEvent,
  voidChallenge,
  getActiveJudges,
  getChallengeSystemConfig,
  updateChallengeSystemConfig,
  getJudgeById,
  upsertJudge,
  playgroundGenerateContent,
  playgroundReviewImage,
  playgroundPickWinners,
} from '~/server/services/challenge.service';
import { getJudgeCommentForImage } from '~/server/services/commentsv2.service';

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

  // Public: Get active challenge events for featured section
  getActiveEvents: publicProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(() => getActiveEvents()),

  // Moderator: Get all challenge events
  getEvents: moderatorProcedure
    .input(getChallengeEventsSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getChallengeEvents(input)),

  // Moderator: Create or update a challenge event
  upsertEvent: moderatorProcedure
    .input(upsertChallengeEventSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input, ctx }) => upsertChallengeEvent({ ...input, userId: ctx.user.id })),

  // Moderator: Delete a challenge event
  deleteEvent: moderatorProcedure
    .input(deleteChallengeSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => deleteChallengeEvent(input.id)),

  // Public: Get judge's comment on a specific image
  getJudgeComment: publicProcedure
    .input(z.object({ imageId: z.number(), judgeUserId: z.number() }))
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getJudgeCommentForImage(input)),

  // --- Judge Playground ---

  // Moderator: Get a single judge by ID with all prompt fields
  getJudgeById: moderatorProcedure
    .input(getJudgeByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getJudgeById(input.id)),

  // Moderator: Create or update a judge
  upsertJudge: moderatorProcedure
    .input(upsertJudgeSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input, ctx }) =>
      upsertJudge({ ...input, userId: input.userId ?? ctx.user.id })
    ),

  // Moderator: Playground — generate content
  playgroundGenerateContent: moderatorProcedure
    .input(playgroundGenerateContentSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => playgroundGenerateContent(input)),

  // Moderator: Playground — review image
  playgroundReviewImage: moderatorProcedure
    .input(playgroundReviewImageSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => playgroundReviewImage(input)),

  // Moderator: Playground — pick winners
  playgroundPickWinners: moderatorProcedure
    .input(playgroundPickWinnersSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input }) => playgroundPickWinners(input)),
});
