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

export const markReadNotificationInput = z.object({
  id: z.number().optional(),
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
});

export type NotificationSingleRowFull = z.infer<typeof notificationSingleRowFull>;
export const notificationSingleRowFull = notificationSingleRow.extend({
  category: z.enum(NotificationCategory),
});

export type NotificationPendingRow = z.infer<typeof notificationPendingRow>;
export const notificationPendingRow = notificationSingleRowFull.omit({ userId: true }).extend({
  users: z.array(z.number()),
});
