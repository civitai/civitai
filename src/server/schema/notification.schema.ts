import * as z from 'zod';
import { NotificationCategory } from '~/server/common/enums';

import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getUserNotificationsSchema = getAllQuerySchema.extend({
  cursor: z.date(),
  unread: z.boolean().default(false),
  category: z.enum(NotificationCategory).nullish(),
});
export type GetUserNotificationsSchema = z.infer<typeof getUserNotificationsSchema>;

export const toggleNotificationSettingInput = z.object({
  toggle: z.boolean(),
  type: z.string().array(),
});
export type ToggleNotificationSettingInput = z.input<typeof toggleNotificationSettingInput>;

export const upsertPushSubscriptionInput = z.object({
  // Browser push endpoints are always https; anything else is a caller fabricating a row the
  // dispatcher would then try to deliver to.
  endpoint: z.url({ protocol: /^https$/ }),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type UpsertPushSubscriptionInput = z.infer<typeof upsertPushSubscriptionInput>;

export const deletePushSubscriptionInput = z.object({
  endpoint: z.string().min(1),
});
export type DeletePushSubscriptionInput = z.infer<typeof deletePushSubscriptionInput>;

export const togglePushSettingInput = z.object({
  type: z.string().array().min(1),
  enabled: z.boolean(),
});
export type TogglePushSettingInput = z.infer<typeof togglePushSettingInput>;

export const markReadNotificationInput = z.object({
  id: z.coerce.bigint().optional(),
  all: z.boolean().optional(),
  category: z.enum(NotificationCategory).nullish(),
});
export type MarkReadNotificationInput = z.infer<typeof markReadNotificationInput>;

export type NotificationSingleRow = z.infer<typeof notificationSingleRow>;
export const notificationSingleRow = z.object({
  key: z.string(),
  userId: z.number(),
  type: z.string(),
  details: z.record(z.string(), z.any()),
  // Shared across every type derivable from the same source event — see @civitai/notifications.
  dedupeKey: z.string().nullish(),
});

export type NotificationSingleRowFull = z.infer<typeof notificationSingleRowFull>;
export const notificationSingleRowFull = notificationSingleRow.extend({
  category: z.enum(NotificationCategory),
});

export type NotificationPendingRow = z.infer<typeof notificationPendingRow>;
export const notificationPendingRow = notificationSingleRowFull.omit({ userId: true }).extend({
  users: z.array(z.number()),
});
