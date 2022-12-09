import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
  getUserNotificationsSchema,
  markReadNotificationInput,
  toggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import {
  getNotificationSettingsHandler,
  getUserNotificationsInfiniteHandler,
  markReadNotificationHandler,
  upsertUserNotificationSettingsHandler,
} from '~/server/controllers/notification.controller';

export const notificationRouter = router({
  getSettings: publicProcedure.query(getNotificationSettingsHandler),
  getAllByUser: protectedProcedure
    .input(getUserNotificationsSchema.partial())
    .query(getUserNotificationsInfiniteHandler),
  markRead: protectedProcedure
    .input(markReadNotificationInput)
    .mutation(markReadNotificationHandler),
  updateUserSettings: protectedProcedure
    .input(toggleNotificationSettingInput)
    .mutation(upsertUserNotificationSettingsHandler),
});
