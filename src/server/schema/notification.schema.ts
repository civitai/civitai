import { z } from 'zod';

import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getUserNotificationsSchema = getAllQuerySchema.extend({
  cursor: z.string(),
  unread: z.boolean().default(false),
});
export type GetUserNotificationsSchema = z.infer<typeof getUserNotificationsSchema>;

export const toggleNotificationSettingInput = z.object({
  toggle: z.boolean(),
  type: z.string(),
  userId: z.number(),
});
export type ToggleNotificationSettingInput = z.input<typeof toggleNotificationSettingInput>;

export const markReadNotificationInput = z.object({
  userId: z.number(),
  id: z.string().optional(),
  all: z.boolean().optional(),
});
export type MarkReadNotificationInput = z.infer<typeof markReadNotificationInput>;
