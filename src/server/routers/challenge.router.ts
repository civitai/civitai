import {
  deleteChallengeSchema,
  getChallengeWinnersSchema,
  getInfiniteChallengesSchema,
  getModeratorChallengesSchema,
  getUpcomingThemesSchema,
  updateChallengeStatusSchema,
  upsertChallengeSchema,
} from '~/server/schema/challenge.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import { moderatorProcedure, publicProcedure, router } from '~/server/trpc';
import {
  deleteChallenge,
  getChallengeDetail,
  getChallengeWinners,
  getInfiniteChallenges,
  getModeratorChallenges,
  getUpcomingThemes,
  updateChallengeStatus,
  upsertChallenge,
} from '~/server/services/challenge.service';

// Router definition
export const challengeRouter = router({
  // Get paginated list of challenges
  getInfinite: publicProcedure
    .input(getInfiniteChallengesSchema)
    .query(({ input }) => getInfiniteChallenges(input)),

  // Get single challenge by ID
  getById: publicProcedure.input(getByIdSchema).query(({ input }) => getChallengeDetail(input.id)),

  // Get upcoming challenge themes for preview widget
  getUpcomingThemes: publicProcedure
    .input(getUpcomingThemesSchema)
    .query(({ input }) => getUpcomingThemes(input.count)),

  // Get challenge winners
  getWinners: publicProcedure
    .input(getChallengeWinnersSchema)
    .query(({ input }) => getChallengeWinners(input.challengeId)),

  // Moderator: Get all challenges (including drafts)
  getModeratorList: moderatorProcedure
    .input(getModeratorChallengesSchema)
    .query(({ input }) => getModeratorChallenges(input)),

  // Moderator: Create or update a challenge
  upsert: moderatorProcedure
    .input(upsertChallengeSchema)
    .mutation(({ input, ctx }) => upsertChallenge({ ...input, userId: ctx.user.id })),

  // Moderator: Update challenge status
  updateStatus: moderatorProcedure
    .input(updateChallengeStatusSchema)
    .mutation(({ input }) => updateChallengeStatus(input.id, input.status)),

  // Moderator: Delete a challenge
  delete: moderatorProcedure
    .input(deleteChallengeSchema)
    .mutation(({ input }) => deleteChallenge(input.id)),
});
