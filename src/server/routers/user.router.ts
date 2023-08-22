import {
  checkUserNotificationsHandler,
  getLeaderboardHandler,
  getNotificationSettingsHandler,
  getUserTagsHandler,
  getUserCreatorHandler,
  getUserFollowingListHandler,
  getUserHiddenListHandler,
  getUserListsHandler,
  toggleFollowUserHandler,
  toggleHideUserHandler,
  toggleBlockedTagHandler,
  batchBlockTagsHandler,
  getUserEngagedModelsHandler,
  getUserEngagedModelVersionsHandler,
  toggleBanHandler,
  toggleHideModelHandler,
  toggleMuteHandler,
  getUserCosmeticsHandler,
  getUsernameAvailableHandler,
  acceptTOSHandler,
  completeOnboardingHandler,
  toggleArticleEngagementHandler,
} from '~/server/controllers/user.controller';
import {
  deleteUserHandler,
  getAllUsersHandler,
  getCreatorsHandler,
  getUserByIdHandler,
  toggleFavoriteModelHandler,
  updateUserHandler,
} from '~/server/controllers/user.controller';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import {
  getAllUsersInput,
  getUserByUsernameSchema,
  getByUsernameSchema,
  toggleModelEngagementInput,
  toggleFollowUserSchema,
  userUpdateSchema,
  deleteUserSchema,
  toggleBlockedTagSchema,
  getUserTagsSchema,
  batchBlockTagsSchema,
  getUserCosmeticsSchema,
  toggleUserArticleEngagementSchema,
} from '~/server/schema/user.schema';
import { getUserArticleEngagements, removeAllContent } from '~/server/services/user.service';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';

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
  update: protectedProcedure.input(userUpdateSchema).mutation(updateUserHandler),
  delete: protectedProcedure.input(deleteUserSchema).mutation(deleteUserHandler),
  toggleFavoriteModel: protectedProcedure
    .input(toggleModelEngagementInput)
    .mutation(toggleFavoriteModelHandler),
  // toggleHideModel: protectedProcedure
  //   .input(toggleModelEngagementInput)
  //   .mutation(toggleHideModelHandler),
  acceptTOS: protectedProcedure.mutation(acceptTOSHandler),
  completeOnboarding: protectedProcedure.mutation(completeOnboardingHandler),
  toggleFollow: protectedProcedure.input(toggleFollowUserSchema).mutation(toggleFollowUserHandler),
  // toggleHide: protectedProcedure.input(toggleFollowUserSchema).mutation(toggleHideUserHandler),
  // toggleBlockedTag: protectedProcedure
  //   .input(toggleBlockedTagSchema)
  //   .mutation(toggleBlockedTagHandler),
  // batchBlockTags: protectedProcedure.input(batchBlockTagsSchema).mutation(batchBlockTagsHandler),
  toggleMute: moderatorProcedure.input(getByIdSchema).mutation(toggleMuteHandler),
  toggleBan: moderatorProcedure.input(getByIdSchema).mutation(toggleBanHandler),
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
  toggleArticleEngagement: protectedProcedure
    .input(toggleUserArticleEngagementSchema)
    .mutation(toggleArticleEngagementHandler),
});
