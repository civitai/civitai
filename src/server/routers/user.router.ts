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
} from '~/server/schema/user.schema';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const userRouter = router({
  getCreator: publicProcedure.input(getUserByUsernameSchema).query(getUserCreatorHandler),
  getAll: publicProcedure.input(getAllUsersInput).query(getAllUsersHandler),
  getById: publicProcedure.input(getByIdSchema).query(getUserByIdHandler),
  getEngagedModels: protectedProcedure.query(getUserEngagedModelsHandler),
  getEngagedModelVersions: protectedProcedure.query(getUserEngagedModelVersionsHandler),
  getFollowingUsers: protectedProcedure.query(getUserFollowingListHandler),
  getHiddenUsers: protectedProcedure.query(getUserHiddenListHandler),
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
  toggleHideModel: protectedProcedure
    .input(toggleModelEngagementInput)
    .mutation(toggleHideModelHandler),
  toggleFollow: protectedProcedure.input(toggleFollowUserSchema).mutation(toggleFollowUserHandler),
  toggleHide: protectedProcedure.input(toggleFollowUserSchema).mutation(toggleHideUserHandler),
  toggleBlockedTag: protectedProcedure
    .input(toggleBlockedTagSchema)
    .mutation(toggleBlockedTagHandler),
  batchBlockTags: protectedProcedure.input(batchBlockTagsSchema).mutation(batchBlockTagsHandler),
  toggleMute: protectedProcedure.input(getByIdSchema).mutation(toggleMuteHandler),
  toggleBan: protectedProcedure.input(getByIdSchema).mutation(toggleBanHandler),
});
