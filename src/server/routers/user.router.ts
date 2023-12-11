import {
  checkUserNotificationsHandler,
  getLeaderboardHandler,
  getNotificationSettingsHandler,
  getUserTagsHandler,
  getUserCreatorHandler,
  getUserFollowingListHandler,
  getUserListsHandler,
  toggleFollowUserHandler,
  getUserEngagedModelsHandler,
  getUserEngagedModelVersionsHandler,
  toggleBanHandler,
  toggleMuteHandler,
  getUserCosmeticsHandler,
  getUsernameAvailableHandler,
  acceptTOSHandler,
  completeOnboardingHandler,
  toggleArticleEngagementHandler,
  toggleBountyEngagementHandler,
  reportProhibitedRequestHandler,
  userByReferralCodeHandler,
  userRewardDetailsHandler,
  claimCosmeticHandler,
} from '~/server/controllers/user.controller';
import {
  deleteUserHandler,
  getAllUsersHandler,
  getCreatorsHandler,
  getUserByIdHandler,
  toggleFavoriteModelHandler,
  updateUserHandler,
} from '~/server/controllers/user.controller';
import { createToken } from '~/server/integrations/integration-token';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import {
  getAllUsersInput,
  getUserByUsernameSchema,
  getByUsernameSchema,
  toggleModelEngagementInput,
  toggleFollowUserSchema,
  userUpdateSchema,
  deleteUserSchema,
  getUserTagsSchema,
  getUserCosmeticsSchema,
  toggleUserArticleEngagementSchema,
  toggleUserBountyEngagementSchema,
  reportProhibitedRequestSchema,
  userByReferralCodeSchema,
  completeOnboardStepSchema,
} from '~/server/schema/user.schema';
import {
  equipCosmetic,
  getUserArticleEngagements,
  getUserBountyEngagements,
  cosmeticStatus,
  removeAllContent,
} from '~/server/services/user.service';
import {
  guardedProcedure,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

export const userRouter = router({
  getCreator: publicProcedure.input(getUserByUsernameSchema).query(getUserCreatorHandler),
  getAll: publicProcedure.input(getAllUsersInput).query(getAllUsersHandler),
  usernameAvailable: protectedProcedure
    .input(getByUsernameSchema)
    .query(getUsernameAvailableHandler),
  getById: publicProcedure.input(getByIdSchema).query(getUserByIdHandler),
  getEngagedModels: protectedProcedure.query(getUserEngagedModelsHandler),
  getEngagedModelVersions: protectedProcedure.query(getUserEngagedModelVersionsHandler),
  getFollowingUsers: protectedProcedure.query(getUserFollowingListHandler),
  // getHiddenUsers: protectedProcedure.query(getUserHiddenListHandler),
  getTags: protectedProcedure.input(getUserTagsSchema.optional()).query(getUserTagsHandler),
  getCreators: publicProcedure.input(getAllQuerySchema.partial()).query(getCreatorsHandler),
  getNotificationSettings: protectedProcedure.query(getNotificationSettingsHandler),
  getLists: publicProcedure.input(getByUsernameSchema).query(getUserListsHandler),
  getLeaderboard: publicProcedure.input(getAllQuerySchema).query(getLeaderboardHandler),
  getCosmetics: protectedProcedure
    .input(getUserCosmeticsSchema.optional())
    .query(getUserCosmeticsHandler),
  checkNotifications: protectedProcedure.query(checkUserNotificationsHandler),
  update: guardedProcedure.input(userUpdateSchema).mutation(updateUserHandler),
  delete: protectedProcedure.input(deleteUserSchema).mutation(deleteUserHandler),
  toggleFavoriteModel: protectedProcedure
    .input(toggleModelEngagementInput)
    .mutation(toggleFavoriteModelHandler),
  // toggleHideModel: protectedProcedure
  //   .input(toggleModelEngagementInput)
  //   .mutation(toggleHideModelHandler),
  acceptTOS: protectedProcedure.mutation(acceptTOSHandler),
  completeOnboardingStep: protectedProcedure
    .input(completeOnboardStepSchema)
    .mutation(completeOnboardingHandler),
  completeOnboarding: protectedProcedure // HACK: this is a hack to deal with people having clients behind...
    .mutation(({ ctx }) => completeOnboardingHandler({ ctx, input: { step: undefined } })),
  toggleFollow: protectedProcedure.input(toggleFollowUserSchema).mutation(toggleFollowUserHandler),
  // toggleHide: protectedProcedure.input(toggleFollowUserSchema).mutation(toggleHideUserHandler),
  // toggleBlockedTag: protectedProcedure
  //   .input(toggleBlockedTagSchema)
  //   .mutation(toggleBlockedTagHandler),
  // batchBlockTags: protectedProcedure.input(batchBlockTagsSchema).mutation(batchBlockTagsHandler),
  toggleMute: moderatorProcedure.input(getByIdSchema).mutation(toggleMuteHandler),
  toggleBan: moderatorProcedure.input(getByIdSchema).mutation(toggleBanHandler),
  getToken: protectedProcedure.query(({ ctx }) => ({ token: createToken(ctx.user.id) })),
  removeAllContent: moderatorProcedure.input(getByIdSchema).mutation(async ({ input, ctx }) => {
    await removeAllContent(input);
    ctx.track.userActivity({
      type: 'RemoveContent',
      targetUserId: input.id,
    });
  }),
  getArticleEngagement: protectedProcedure.query(({ ctx }) =>
    getUserArticleEngagements({ userId: ctx.user.id })
  ),
  getBountyEngagement: protectedProcedure.query(({ ctx }) =>
    getUserBountyEngagements({ userId: ctx.user.id })
  ),
  toggleArticleEngagement: protectedProcedure
    .input(toggleUserArticleEngagementSchema)
    .mutation(toggleArticleEngagementHandler),
  toggleBountyEngagement: protectedProcedure
    .input(toggleUserBountyEngagementSchema)
    .mutation(toggleBountyEngagementHandler),
  reportProhibitedRequest: protectedProcedure
    .input(reportProhibitedRequestSchema)
    .mutation(reportProhibitedRequestHandler),
  userByReferralCode: publicProcedure
    .input(userByReferralCodeSchema)
    .query(userByReferralCodeHandler),
  userRewardDetails: protectedProcedure.query(userRewardDetailsHandler),
  cosmeticStatus: protectedProcedure
    .input(getByIdSchema)
    .query(({ ctx, input }) => cosmeticStatus({ userId: ctx.user.id, id: input.id })),
  claimCosmetic: protectedProcedure.input(getByIdSchema).mutation(claimCosmeticHandler),
  equipCosmetic: protectedProcedure
    .input(getByIdSchema)
    .mutation(({ ctx, input }) => equipCosmetic({ userId: ctx.user.id, cosmeticId: input.id })),
});
