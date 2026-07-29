import {
  checkUserNotificationsHandler,
  claimCosmeticHandler,
  completeOnboardingHandler,
  deleteUserHandler,
  deleteUserPaymentMethodHandler,
  dismissAlertHandler,
  restoreAlertHandler,
  restoreUserHandler,
  getAllUsersHandler,
  getCreatorsHandler,
  getLeaderboardHandler,
  getNotificationSettingsHandler,
  getSelfStatusHandler,
  getUserBookmarkCollectionsHandler,
  getUserByIdHandler,
  getUserCosmeticsHandler,
  getUserCreatorHandler,
  getUserEngagedModelsByIdsHandler,
  getUserEngagedModelVersionsHandler,
  getUserFeatureFlagsHandler,
  getUserFollowingListHandler,
  getUserListHandler,
  getUserListsHandler,
  getUsernameAvailableHandler,
  getUserPaymentMethodsHandler,
  getUserPurchasedRewardsHandler,
  getBanContentPreviewHandler,
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
  deleteUserSchema,
  dismissAlertSchema,
  restoreAlertSchema,
  restoreUserSchema,
  getAllUsersInput,
  getEngagedModelsByIdsSchema,
  getByUsernameSchema,
  getUserByUsernameSchema,
  getUserCosmeticsSchema,
  getUserListSchema,
  getUserTagsSchema,
  setLeaderboardEligbilitySchema,
  setUserSettingsInput,
  getBanContentPreviewSchema,
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
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';
import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt, rateLimit } from '~/server/middleware.trpc';
import { refreshSession } from '~/server/auth/session-invalidation';
import { createTipaltiPayee } from '~/server/services/user-payment-configuration.service';
import { addSystemPermission } from '~/server/services/system-cache';
import { createNotification } from '~/server/services/notification.service';
import { NotificationCategory } from '~/server/common/enums';
import { invalidateSubscriptionCaches } from '~/server/utils/subscription.utils';
import { dbRead } from '~/server/db/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const userRouter = router({
  getCreator: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getUserByUsernameSchema)
    .use(
      edgeCacheIt({
        ttl: CacheTTL.sm,
        tags: (input) =>
          [
            input?.id ? `user-creator-${input.id}` : undefined,
            input?.username ? `user-creator-${input.username}` : undefined,
          ].filter(Boolean) as string[],
      })
    )
    .query(getUserCreatorHandler),
  getAll: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getAllUsersInput)
    .query(getAllUsersHandler),
  usernameAvailable: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByUsernameSchema)
    .query(getUsernameAvailableHandler),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(getUserByIdHandler),
  getSelfStatus: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getSelfStatusHandler),
  getEngagedModelsByIds: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getEngagedModelsByIdsSchema)
    .query(getUserEngagedModelsByIdsHandler),
  getEngagedModelVersions: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(getUserEngagedModelVersionsHandler),
  getFollowingUsers: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getUserFollowingListHandler),
  // getHiddenUsers: protectedProcedure.query(getUserHiddenListHandler),
  getTags: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getUserTagsSchema.optional())
    .query(getUserTagsHandler),
  getCreators: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getAllQuerySchema.partial())
    .query(getCreatorsHandler),
  getNotificationSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsRead })
    .query(getNotificationSettingsHandler),
  getLists: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByUsernameSchema)
    .query(getUserListsHandler),
  getList: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getUserListSchema)
    .query(getUserListHandler),
  getLeaderboard: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getAllQuerySchema)
    .query(getLeaderboardHandler),
  getCosmetics: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getUserCosmeticsSchema.optional())
    .query(getUserCosmeticsHandler),
  checkNotifications: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsRead })
    .query(checkUserNotificationsHandler),
  update: guardedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(userUpdateSchema)
    .mutation(updateUserHandler),
  requestEmailChange: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(requestEmailChangeSchema)
    .use(
      rateLimit({
        limit: 2,
        period: 24 * 60 * 60,
        errorMessage: 'You can only request 2 email changes per day. Please try again tomorrow.',
      })
    )
    .mutation(async ({ input, ctx }) => {
      return requestEmailChange(ctx.user.id, input.newEmail);
    }),
  validateEmailToken: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(validateEmailTokenSchema)
    .query(async ({ input }) => {
      return validateEmailChangeToken(input.token);
    }),
  verifyEmailChange: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(verifyEmailChangeSchema)
    .mutation(async ({ input }) => {
      return confirmEmailChange(input.token);
    }),
  updateBrowsingMode: guardedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(updateBrowsingModeSchema)
    .mutation(async ({ input, ctx }) => {
      await updateUserById({
        id: ctx.user.id,
        data: input,
        updateSource: 'updateBrowsingMode',
      });
      await refreshSession(ctx.user.id);
    }),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(deleteUserSchema)
    .mutation(deleteUserHandler),
  toggleFavorite: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleFavoriteInput)
    .mutation(toggleFavoriteHandler),
  toggleNotifyModel: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleModelEngagementInput)
    .mutation(toggleNotifyModelHandler),
  completeOnboardingStep: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(userOnboardingSchema)
    .mutation(completeOnboardingHandler),
  toggleFollow: verifiedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleFollowUserSchema)
    .mutation(toggleFollowUserHandler),
  toggleMute: moderatorProcedure.input(getByIdSchema).mutation(toggleMuteHandler),
  toggleBan: moderatorProcedure.input(toggleBanUserSchema).mutation(toggleBanHandler),
  getBanContentPreview: moderatorProcedure
    .input(getBanContentPreviewSchema)
    .query(getBanContentPreviewHandler),
  restoreAccount: moderatorProcedure.input(restoreUserSchema).mutation(restoreUserHandler),
  getToken: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .query(({ ctx }) => ({ token: createToken(ctx.user.id) })),
  removeAllContent: moderatorProcedure.input(getByIdSchema).mutation(async ({ input, ctx }) => {
    await removeAllContent(input);
    ctx.track.userActivity({
      type: 'RemoveContent',
      targetUserId: input.id,
    });
  }),
  getArticleEngagement: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getUserArticleEngagements({ userId: ctx.user.id })),
  getBookmarkedArticles: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getUserBookmarkedArticles({ userId: ctx.user.id })),
  getBookmarkedModels: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getUserBookmarkedModels({ userId: ctx.user.id })),
  getBountyEngagement: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(({ ctx }) => getUserBountyEngagements({ userId: ctx.user.id })),
  toggleArticleEngagement: verifiedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleUserArticleEngagementSchema)
    .mutation(toggleArticleEngagementHandler),
  toggleBookmarkedArticle: verifiedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(getByIdSchema)
    .mutation(({ ctx, input }) =>
      toggleBookmarkedArticle({ articleId: input.id, userId: ctx.user.id })
    ),
  toggleBountyEngagement: verifiedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite })
    .input(toggleUserBountyEngagementSchema)
    .mutation(toggleBountyEngagementHandler),
  userByReferralCode: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(userByReferralCodeSchema)
    .query(userByReferralCodeHandler),
  userRewardDetails: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(userRewardDetailsHandler),
  cosmeticStatus: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getByIdSchema)
    .query(({ ctx, input }) => cosmeticStatus({ userId: ctx.user.id, id: input.id })),
  claimCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(getByIdSchema)
    .mutation(claimCosmeticHandler),
  equipCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(getByIdSchema)
    .mutation(({ ctx, input }) => equipCosmetic({ userId: ctx.user.id, cosmeticId: input.id })),
  getPaymentMethods: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .query(getUserPaymentMethodsHandler),
  deletePaymentMethod: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(paymentMethodDeleteInput)
    .mutation(deleteUserPaymentMethodHandler),
  getFeatureFlags: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getUserFeatureFlagsHandler),
  toggleFeature: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(toggleFeatureInputSchema)
    .mutation(toggleUserFeatureFlagHandler),
  getSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getUserSettingsHandler),
  setSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setUserSettingsInput)
    .mutation(setUserSettingHandler),
  dismissAlert: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(dismissAlertSchema)
    .mutation(dismissAlertHandler),
  restoreAlert: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(restoreAlertSchema)
    .mutation(restoreAlertHandler),
  getBookmarkCollections: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getUserBookmarkCollectionsHandler),
  getUserPurchasedRewards: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .query(getUserPurchasedRewardsHandler),
  setLeaderboardEligibility: moderatorProcedure
    .input(setLeaderboardEligbilitySchema)
    .mutation(setLeaderboardEligibilityHandler),
  requestAdToken: verifiedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .mutation(({ ctx }) => requestAdToken({ userId: ctx.user.id })),
  updateContentSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(updateContentSettingsSchema)
    .mutation(({ input, ctx }) => updateContentSettings({ userId: ctx.user.id, ...input })),
  getTipaltiStatus: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(isFlagProtected('userPaymentConfiguration'))
    .input(getByIdSchema)
    .query(async ({ input }) => {
      const config = await dbRead.userPaymentConfiguration.findUnique({
        where: { userId: input.id },
        select: { tipaltiAccountId: true },
      });
      return { enabled: !!config?.tipaltiAccountId };
    }),
  enableTipalti: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(isFlagProtected('userPaymentConfiguration'))
    .input(getByIdSchema)
    .mutation(async ({ input }) => {
      await createTipaltiPayee({ userId: input.id });
      await createNotification({
        userId: input.id,
        type: 'creators-program-enabled',
        category: NotificationCategory.System,
        key: `creators-program-enabled:${input.id}`,
        details: {},
      }).catch();
      await addSystemPermission('creatorsProgram', input.id);
    }),
  resetSubscriptionCaches: protectedProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(isFlagProtected('userPaymentConfiguration'))
    .input(getByIdSchema)
    .mutation(async ({ input }) => {
      await invalidateSubscriptionCaches(input.id);
    }),
});
