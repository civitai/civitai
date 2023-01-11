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
} from '~/server/controllers/user.controller';
import {
  deleteUserHandler,
  getAllUsersHandler,
  getCreatorsHandler,
  getUserByIdHandler,
  getUserFavoriteModelsHandler,
  toggleFavoriteModelHandler,
  updateUserHandler,
} from '~/server/controllers/user.controller';
import { getAllQuerySchema, getByIdSchema } from '~/server/schema/base.schema';
import {
  getAllUsersInput,
  getUserByUsernameSchema,
  getByUsernameSchema,
  toggleFavoriteModelInput,
  toggleFollowUserSchema,
  userUpsertSchema,
  deleteUserSchema,
  toggleBlockedTagSchema,
  getUserTagsSchema,
  batchBlockTagsSchema,
} from '~/server/schema/user.schema';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const userRouter = router({
  getCreator: publicProcedure.input(getUserByUsernameSchema).query(getUserCreatorHandler),
  getAll: publicProcedure.input(getAllUsersInput).query(getAllUsersHandler),
  getById: publicProcedure.input(getByIdSchema).query(getUserByIdHandler),
  getFavoriteModels: protectedProcedure.query(getUserFavoriteModelsHandler),
  getFollowingUsers: protectedProcedure.query(getUserFollowingListHandler),
  getHiddenUsers: protectedProcedure.query(getUserHiddenListHandler),
  getTags: protectedProcedure.input(getUserTagsSchema.optional()).query(getUserTagsHandler),
  getCreators: publicProcedure.input(getAllQuerySchema.partial()).query(getCreatorsHandler),
  getNotificationSettings: protectedProcedure.query(getNotificationSettingsHandler),
  getLists: publicProcedure.input(getByUsernameSchema).query(getUserListsHandler),
  getLeaderboard: publicProcedure.input(getAllQuerySchema).query(getLeaderboardHandler),
  checkNotifications: protectedProcedure.query(checkUserNotificationsHandler),
  update: protectedProcedure.input(userUpsertSchema.partial()).mutation(updateUserHandler),
  delete: protectedProcedure.input(deleteUserSchema).mutation(deleteUserHandler),
  toggleFavorite: protectedProcedure
    .input(toggleFavoriteModelInput)
    .mutation(toggleFavoriteModelHandler),
  toggleFollow: protectedProcedure.input(toggleFollowUserSchema).mutation(toggleFollowUserHandler),
  toggleHide: protectedProcedure.input(toggleFollowUserSchema).mutation(toggleHideUserHandler),
  toggleBlockedTag: protectedProcedure
    .input(toggleBlockedTagSchema)
    .mutation(toggleBlockedTagHandler),
  batchBlockTags: protectedProcedure.input(batchBlockTagsSchema).mutation(batchBlockTagsHandler),
});
