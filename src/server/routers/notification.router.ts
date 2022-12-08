import { protectedProcedure, router } from '~/server/trpc';
import {
  getUserNotificationsSchema,
  markReadNotificationInput,
  upsertNotificationSettingInput,
} from '~/server/schema/notification.schema';
import {
  getUserNotificationsInfiniteHandler,
  markReadNotificationHandler,
  upsertNotificationSettingsHandler,
} from '~/server/controllers/notification.controller';

export const notificationRouter = router({
  getAllByUser: protectedProcedure
    .input(getUserNotificationsSchema.partial())
    .query(getUserNotificationsInfiniteHandler),
  markRead: protectedProcedure
    .input(markReadNotificationInput)
    .mutation(markReadNotificationHandler),
  updateUserSettings: protectedProcedure
    .input(upsertNotificationSettingInput)
    .mutation(upsertNotificationSettingsHandler),
});
