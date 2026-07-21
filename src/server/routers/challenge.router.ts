import {
  challengeQuickActionSchema,
  checkEntryEligibilitySchema,
  deleteChallengeSchema,
  getChallengeEventsSchema,
  getChallengeWinnersSchema,
  getCompletedChallengesWithWinnersSchema,
  getInfiniteChallengesSchema,
  getModeratorChallengesSchema,
  getMyParticipatedSchema,
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
  upsertChallengeCategorySchema,
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
  deleteUserChallenge,
  endChallengeAndPickWinners,
  getActiveEvents,
  getChallengeEventById,
  getChallengeDetail,
  getChallengeForEdit,
  getChallengeEvents,
  getChallengeWinners,
  getCompletedChallengesWithWinners,
  getDailyChallenges,
  getInfiniteChallenges,
  getModeratorChallenges,
  getMyParticipated,
  getUpcomingThemes,
  getUserChallengeForEdit,
  getUserEntryCount,
  getUserUnjudgedEntries,
  getWinnerCooldownStatus,
  requestReview,
  upsertChallenge,
  upsertUserChallenge,
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
import {
  getChallengeCategoriesFull,
  getJudgingCategoryOptions,
  upsertChallengeCategory,
} from '~/server/services/challenge-category.service';
import { getUserChallengeCreateEligibility } from '~/server/services/challenge-eligibility.service';
import { getJudgeCommentForImage } from '~/server/services/commentsv2.service';
import { deriveDomainCurrency } from '~/server/games/daily-challenge/challenge-currency';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Router definition
export const challengeRouter = router({
  // Get paginated list of challenges
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getInfiniteChallengesSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) =>
      getInfiniteChallenges({
        ...input,
        currentUserId: ctx.user?.id,
        isGreen: ctx.features.isGreen,
        canAccessUserChallenges: ctx.features.userChallenges,
      })
    ),

  // Active + next few upcoming daily (System) challenges for the horizontal daily row
  getDaily: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .use(isFlagProtected('challengePlatform'))
    .query(() => getDailyChallenges()),

  // Current user's recently participated-in challenges (entered or won), recent-first.
  getMyParticipated: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getMyParticipatedSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) =>
      getMyParticipated({ ...input, userId: ctx.user.id, isGreen: ctx.features.isGreen })
    ),

  // Get single challenge by ID (public — sensitive fields stripped)
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) =>
      getChallengeDetail(
        input.id,
        ctx.user?.id,
        ctx.features.isGreen,
        ctx.user?.isModerator,
        ctx.features.userChallenges
      )
    ),

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
    .query(({ input, ctx }) =>
      getChallengeWinners(input.challengeId, {
        isGreen: ctx.features.isGreen,
        viewerId: ctx.user?.id,
      })
    ),

  // Get completed challenges with inline winners for previous winners page
  getCompletedWithWinners: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getCompletedChallengesWithWinnersSchema)
    .use(isFlagProtected('challengePlatform'))
    .query(({ input, ctx }) =>
      getCompletedChallengesWithWinners({
        ...input,
        isGreen: ctx.features.isGreen,
        currentUserId: ctx.user?.id,
      })
    ),

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
    .mutation(({ input, ctx }) =>
      requestReview(input.challengeId, input.imageIds, ctx.user.id, ctx.features.userChallenges)
    ),

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

  // User: create-eligibility status for the create page (non-throwing; mirrors the create gate).
  // Read-only and returns only the caller's own score/limits, so it is NOT behind `userChallenges`:
  // that flag evaluates to false in static tRPC middleware for non-mods (availability ['mod']) even
  // when the page's SSR gate lets them in via Flipt, which would FORBIDDEN this query and hide the
  // requirements card. The write path (upsertUserChallenge) keeps the `userChallenges` guard.
  getCreateEligibility: protectedProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(({ ctx }) => getUserChallengeCreateEligibility(ctx.user.id)),

  // User: fetch own Scheduled challenge for editing (owner/moderator-guarded in the service).
  getUserChallengeForEdit: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .use(isFlagProtected('userChallenges'))
    .query(({ input, ctx }) =>
      getUserChallengeForEdit({
        id: input.id,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),

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

  // User: Create or update a user-owned challenge.
  // Eligibility (score + standing + tier cap), ownership, and edit-locks are enforced
  // in the service (upsertUserChallenge). Dark behind the `userChallenges` flag.
  upsertUserChallenge: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite, blockApiKeys: true })
    .input(userChallengeUpsertSchema)
    .use(isFlagProtected('challengePlatform'))
    .use(isFlagProtected('userChallenges'))
    .mutation(({ input, ctx }) =>
      upsertUserChallenge({
        ...input,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
        buzzType: input.buzzType ?? deriveDomainCurrency(ctx.features.isGreen),
      })
    ),

  // User: delete own Scheduled, entry-free challenge (refunds escrowed prize). Owner/status guards
  // enforced in the service.
  deleteUserChallenge: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite, blockApiKeys: true })
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .use(isFlagProtected('userChallenges'))
    .mutation(({ input, ctx }) => deleteUserChallenge({ id: input.id, userId: ctx.user.id })),

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

  // Active judges for the challenge form dropdowns. Any authenticated user may call it; the service
  // returns the full list (with sensitive fields) to moderators and the public, SFW-selectable subset
  // to everyone else, based on the real ctx.user.isModerator.
  getJudges: protectedProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(({ ctx }) => getActiveJudges({ isModerator: !!ctx.user.isModerator })),

  // Active judging categories for the challenge form picker (key/label/group/criteria only).
  getJudgingCategories: protectedProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(() => getJudgingCategoryOptions()),

  // Moderator: full category library incl. server-only rubric text (playground Categories tab).
  getChallengeCategories: moderatorProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(() => getChallengeCategoriesFull()),

  // Moderator: create/update a category library row.
  upsertChallengeCategory: moderatorProcedure
    .use(isFlagProtected('challengePlatform'))
    .input(upsertChallengeCategorySchema)
    .mutation(({ input }) => upsertChallengeCategory(input)),

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

  // Public: Get single event by ID
  getEventById: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(z.object({ id: z.number() }))
    .use(isFlagProtected('challengePlatform'))
    .query(({ input }) => getChallengeEventById(input.id)),

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
