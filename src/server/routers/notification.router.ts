import { protectedProcedure, router } from '~/server/trpc';
import {
  getUserNotificationsSchema,
  markReadNotificationInput,
  toggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import {
  getUserNotificationsInfiniteHandler,
  upsertUserNotificationSettingsHandler,
} from '~/server/controllers/notification.controller';
import { markNotificationsRead } from '~/server/services/notification.service';

export const notificationRouter = router({
  getAllByUser: protectedProcedure
    .input(getUserNotificationsSchema.partial())
    .query(getUserNotificationsInfiniteHandler),
  markRead: protectedProcedure
    .input(markReadNotificationInput)
    .mutation(({ input, ctx }) => markNotificationsRead({ ...input, userId: ctx.user.id })),
  updateUserSettings: protectedProcedure
    .input(toggleNotificationSettingInput)
    .mutation(upsertUserNotificationSettingsHandler),
});
