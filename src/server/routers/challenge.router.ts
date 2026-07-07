import {
  challengeQuickActionSchema,
  checkEntryEligibilitySchema,
  deleteChallengeSchema,
  getChallengeEventsSchema,
  getChallengeWinnersSchema,
  getCompletedChallengesWithWinnersSchema,
  getInfiniteChallengesSchema,
  getModeratorChallengesSchema,
  getUpcomingThemesSchema,
  getUserEntryCountSchema,
  getUserUnjudgedEntriesSchema,
  getWinnerCooldownStatusSchema,
  requestReviewSchema,
  upsertChallengeSchema,
  userChallengeUpsertSchema,
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
  getChallengeForEdit,
  getChallengeEvents,
  getChallengeWinners,
  getCompletedChallengesWithWinners,
  getInfiniteChallenges,
  getModeratorChallenges,
  getUpcomingThemes,
  getUserEntryCount,
  getUserUnjudgedEntries,
  getWinnerCooldownStatus,
  requestReview,
  upsertChallenge,
  upsertUserChallenge,
  getActiveJudgeOptions,
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
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Router definition
export const challengeRouter = router({
  // Get paginated list of challenges
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteChallengesSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) => getInfiniteChallenges({ ...input, currentUserId: ctx.user?.id })),

  // Get single challenge by ID (public — sensitive fields stripped)
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) => getChallengeDetail(input.id, ctx.user?.id)),

  // Get upcoming challenge themes for preview widget
  getUpcomingThemes: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getUpcomingThemesSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getUpcomingThemes(input.count)),

  // Get challenge winners
  getWinners: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getChallengeWinnersSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getChallengeWinners(input.challengeId)),

  // Get completed challenges with inline winners for previous winners page
  getCompletedWithWinners: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getCompletedChallengesWithWinnersSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getCompletedChallengesWithWinners(input)),

  // Get winner cooldown status for current user on a challenge
  getWinnerCooldownStatus: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getWinnerCooldownStatusSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) => getWinnerCooldownStatus(input.challengeId, ctx.user.id)),

  // Get current user's entry count for a challenge
  getUserEntryCount: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getUserEntryCountSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) => getUserEntryCount(input.challengeId, ctx.user.id)),

  // Pay to guarantee entries get reviewed by the AI judge
  requestReview: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite, blockApiKeys: true })
    .input(requestReviewSchema)
    .use(isFlagProtected('challengePlatform'))
    .mutation(({ input, ctx }) => requestReview(input.challengeId, input.imageIds, ctx.user.id)),

  // Get user's unjudged entries for paid review selection
  getUserUnjudgedEntries: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getUserUnjudgedEntriesSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) => getUserUnjudgedEntries(input.challengeId, ctx.user.id)),

  // Check image eligibility for a challenge
  checkEntryEligibility: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(checkEntryEligibilitySchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => checkImageEligibility(input.challengeId, input.imageIds)),

  // Moderator: Get full challenge detail for editing (includes sensitive fields)
  getForEdit: moderatorProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getChallengeForEdit(input.id)),

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

  // User: judge options for the create form (id/name/bio only)
  getJudgeOptions: protectedProcedure
    .use(isFlagProtected('challengePlatform'))
    .use(isFlagProtected('userChallenges'))
    .query(() => getActiveJudgeOptions()),

  // User: Create or update a user-owned challenge.
  // Eligibility (score + standing + tier cap), ownership, and edit-locks are enforced
  // in the service (upsertUserChallenge). Dark behind the `userChallenges` flag.
  upsertUserChallenge: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite, blockApiKeys: true })
    .input(userChallengeUpsertSchema)
    .use(isFlagProtected('challengePlatform'))
    .use(isFlagProtected('userChallenges'))
    .mutation(({ input, ctx }) => upsertUserChallenge({ ...input, userId: ctx.user.id })),

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
    .meta({ requiredScope: TokenScope.MediaRead })
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
    .meta({ requiredScope: TokenScope.MediaRead })
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
    .mutation(({ input, ctx }) => upsertJudge({ ...input, userId: input.userId ?? ctx.user.id })),

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
