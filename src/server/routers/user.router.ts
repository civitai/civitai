import {
  checkUserNotificationsHandler,
  claimCosmeticHandler,
  completeOnboardingHandler,
  deleteUserHandler,
  deleteUserPaymentMethodHandler,
  dismissAlertHandler,
  getAllUsersHandler,
  getCreatorsHandler,
  getLeaderboardHandler,
  getNotificationSettingsHandler,
  getUserBookmarkCollectionsHandler,
  getUserByIdHandler,
  getUserCosmeticsHandler,
  getUserCreatorHandler,
  getUserEngagedModelsHandler,
  getUserEngagedModelVersionsHandler,
  getUserFeatureFlagsHandler,
  getUserFollowingListHandler,
  getUserListHandler,
  getUserListsHandler,
  getUsernameAvailableHandler,
  getUserPaymentMethodsHandler,
  getUserPurchasedRewardsHandler,
  getUserSettingsHandler,
  getUserTagsHandler,
  setLeaderboardEligibilityHandler,
  setUserSettingHandler,
  toggleArticleEngagementHandler,
  toggleBanHandler,
  toggleBountyEngagementHandler,
  toggleFavoriteHandler,
  toggleFollowUserHandler,
  toggleMuteHandler,
  toggleNotifyModelHandler,
  toggleUserFeatureFlagHandler,
  updateUserHandler,
  userByReferralCodeHandler,
  userRewardDetailsHandler,
} from '~/server/controllers/user.controller';
import { createToken } from '~/server/integrations/integration-token';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import { paymentMethodDeleteInput } from '~/server/schema/stripe.schema';
import {
  computeDeviceFingerprintSchema,
  deleteUserSchema,
  dismissAlertSchema,
  getAllUsersInput,
  getByUsernameSchema,
  getUserByUsernameSchema,
  getUserCosmeticsSchema,
  getUserListSchema,
  getUserTagsSchema,
  setLeaderboardEligbilitySchema,
  setUserSettingsInput,
  toggleBanUserSchema,
  toggleFavoriteInput,
  toggleFeatureInputSchema,
  toggleFollowUserSchema,
  toggleModelEngagementInput,
  toggleUserArticleEngagementSchema,
  toggleUserBountyEngagementSchema,
  updateBrowsingModeSchema,
  updateContentSettingsSchema,
  userByReferralCodeSchema,
  userOnboardingSchema,
  userUpdateSchema,
  requestEmailChangeSchema,
  verifyEmailChangeSchema,
  validateEmailTokenSchema,
} from '~/server/schema/user.schema';
import {
  computeFingerprint,
  cosmeticStatus,
  equipCosmetic,
  getUserArticleEngagements,
  getUserBookmarkedArticles,
  getUserBookmarkedModels,
  getUserBountyEngagements,
  removeAllContent,
  requestAdToken,
  toggleBookmarkedArticle,
  updateContentSettings,
  updateUserById,
} from '~/server/services/user.service';
import {
  requestEmailChange,
  confirmEmailChange,
  validateEmailChangeToken,
} from '~/server/services/email-verification.service';
import {
  guardedProcedure,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';
import { refreshSession } from '~/server/auth/session-invalidation';

export const userRouter = router({
  getCreator: publicProcedure.input(getUserByUsernameSchema).query(getUserCreatorHandler),
  getAll: publicProcedure.input(getAllUsersInput).query(getAllUsersHandler),
  usernameAvailable: protectedProcedure
    .input(getByUsernameSchema)
    .query(getUsernameAvailableHandler),
  getById: publicProcedure.input(getByIdSchema).query(getUserByIdHandler),
  getEngagedModels: protectedProcedure.query(getUserEngagedModelsHandler),
  getEngagedModelVersions: protectedProcedure
    .input(getByIdSchema)
    .query(getUserEngagedModelVersionsHandler),
  getFollowingUsers: protectedProcedure.query(getUserFollowingListHandler),
  // getHiddenUsers: protectedProcedure.query(getUserHiddenListHandler),
  getTags: protectedProcedure.input(getUserTagsSchema.optional()).query(getUserTagsHandler),
  getCreators: publicProcedure.input(getAllQuerySchema.partial()).query(getCreatorsHandler),
  getNotificationSettings: protectedProcedure.query(getNotificationSettingsHandler),
  getLists: publicProcedure.input(getByUsernameSchema).query(getUserListsHandler),
  getList: publicProcedure.input(getUserListSchema).query(getUserListHandler),
  getLeaderboard: publicProcedure.input(getAllQuerySchema).query(getLeaderboardHandler),
  getCosmetics: protectedProcedure
    .input(getUserCosmeticsSchema.optional())
    .query(getUserCosmeticsHandler),
  checkNotifications: protectedProcedure.query(checkUserNotificationsHandler),
  update: guardedProcedure.input(userUpdateSchema).mutation(updateUserHandler),
  requestEmailChange: protectedProcedure
    .input(requestEmailChangeSchema)
    .mutation(async ({ input, ctx }) => {
      return requestEmailChange(ctx.user.id, input.newEmail);
    }),
  validateEmailToken: publicProcedure.input(validateEmailTokenSchema).query(async ({ input }) => {
    return validateEmailChangeToken(input.token);
  }),
  verifyEmailChange: publicProcedure.input(verifyEmailChangeSchema).mutation(async ({ input }) => {
    return confirmEmailChange(input.token);
  }),
  updateBrowsingMode: guardedProcedure
    .input(updateBrowsingModeSchema)
    .mutation(async ({ input, ctx }) => {
      await updateUserById({
        id: ctx.user.id,
        data: input,
        updateSource: 'updateBrowsingMode',
      });
      await refreshSession(ctx.user.id);
    }),
  delete: protectedProcedure.input(deleteUserSchema).mutation(deleteUserHandler),
  toggleFavorite: protectedProcedure.input(toggleFavoriteInput).mutation(toggleFavoriteHandler),
  toggleNotifyModel: protectedProcedure
    .input(toggleModelEngagementInput)
    .mutation(toggleNotifyModelHandler),
  completeOnboardingStep: protectedProcedure
    .input(userOnboardingSchema)
    .mutation(completeOnboardingHandler),
  toggleFollow: verifiedProcedure.input(toggleFollowUserSchema).mutation(toggleFollowUserHandler),
  toggleMute: moderatorProcedure.input(getByIdSchema).mutation(toggleMuteHandler),
  toggleBan: moderatorProcedure.input(toggleBanUserSchema).mutation(toggleBanHandler),
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
  getBookmarkedArticles: protectedProcedure.query(({ ctx }) =>
    getUserBookmarkedArticles({ userId: ctx.user.id })
  ),
  getBookmarkedModels: protectedProcedure.query(({ ctx }) =>
    getUserBookmarkedModels({ userId: ctx.user.id })
  ),
  getBountyEngagement: protectedProcedure.query(({ ctx }) =>
    getUserBountyEngagements({ userId: ctx.user.id })
  ),
  toggleArticleEngagement: verifiedProcedure
    .input(toggleUserArticleEngagementSchema)
    .mutation(toggleArticleEngagementHandler),
  toggleBookmarkedArticle: verifiedProcedure
    .input(getByIdSchema)
    .mutation(({ ctx, input }) =>
      toggleBookmarkedArticle({ articleId: input.id, userId: ctx.user.id })
    ),
  toggleBountyEngagement: verifiedProcedure
    .input(toggleUserBountyEngagementSchema)
    .mutation(toggleBountyEngagementHandler),
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
  getPaymentMethods: protectedProcedure.query(getUserPaymentMethodsHandler),
  deletePaymentMethod: protectedProcedure
    .input(paymentMethodDeleteInput)
    .mutation(deleteUserPaymentMethodHandler),
  getFeatureFlags: protectedProcedure.query(getUserFeatureFlagsHandler),
  toggleFeature: protectedProcedure
    .input(toggleFeatureInputSchema)
    .mutation(toggleUserFeatureFlagHandler),
  getSettings: protectedProcedure.query(getUserSettingsHandler),
  setSettings: protectedProcedure.input(setUserSettingsInput).mutation(setUserSettingHandler),
  dismissAlert: protectedProcedure.input(dismissAlertSchema).mutation(dismissAlertHandler),
  getBookmarkCollections: protectedProcedure.query(getUserBookmarkCollectionsHandler),
  getUserPurchasedRewards: protectedProcedure.query(getUserPurchasedRewardsHandler),
  setLeaderboardEligibility: moderatorProcedure
    .input(setLeaderboardEligbilitySchema)
    .mutation(setLeaderboardEligibilityHandler),
  ingestFingerprint: publicProcedure
    .input(computeDeviceFingerprintSchema)
    .mutation(({ input, ctx }) =>
      computeFingerprint({ fingerprint: input.fingerprint, userId: ctx.user?.id })
    ),
  requestAdToken: verifiedProcedure.mutation(({ ctx }) => requestAdToken({ userId: ctx.user.id })),
  updateContentSettings: protectedProcedure
    .input(updateContentSettingsSchema)
    .mutation(({ input, ctx }) => updateContentSettings({ userId: ctx.user.id, ...input })),
});
