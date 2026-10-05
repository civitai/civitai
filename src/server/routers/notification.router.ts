import {
  getUserNotificationsInfiniteHandler,
  upsertUserNotificationSettingsHandler,
} from '~/server/controllers/notification.controller';
import {
  deletePushSubscriptionInput,
  getUserNotificationsSchema,
  markReadNotificationInput,
  toggleNotificationSettingInput,
  togglePushSettingInput,
  upsertPushSubscriptionInput,
} from '~/server/schema/notification.schema';
import {
  deletePushSubscription,
  getUserPushSettings,
  getUserPushSubscriptions,
  markNotificationsRead,
  togglePushSetting,
  upsertPushSubscription,
} from '~/server/services/notification.service';
import { protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const notificationRouter = router({
  getAllByUser: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsRead })
    .input(getUserNotificationsSchema.partial())
    .query(getUserNotificationsInfiniteHandler),
  markRead: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsWrite })
    .input(markReadNotificationInput)
    .mutation(({ input, ctx }) => markNotificationsRead({ ...input, userId: ctx.user.id })),
  updateUserSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsWrite })
    .input(toggleNotificationSettingInput)
    .mutation(upsertUserNotificationSettingsHandler),
  getPushSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsRead })
    .query(({ ctx }) => getUserPushSettings({ userId: ctx.user.id })),
  getPushSubscriptions: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsRead })
    .query(({ ctx }) => getUserPushSubscriptions({ userId: ctx.user.id })),
  subscribePush: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsWrite })
    .input(upsertPushSubscriptionInput)
    .mutation(({ input, ctx }) =>
      upsertPushSubscription({
        ...input,
        userId: ctx.user.id,
        userAgent: ctx.req?.headers['user-agent'],
      })
    ),
  unsubscribePush: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsWrite })
    .input(deletePushSubscriptionInput)
    .mutation(({ input, ctx }) => deletePushSubscription({ ...input, userId: ctx.user.id })),
  updatePushSettings: protectedProcedure
    .meta({ requiredScope: TokenScope.NotificationsWrite })
    .input(togglePushSettingInput)
    .mutation(({ input, ctx }) => togglePushSetting({ ...input, userId: ctx.user.id })),
});
