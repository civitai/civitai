import { z } from 'zod';

import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getUserNotificationsSchema = getAllQuerySchema.extend({
  cursor: z.string().cuid(),
  unread: z.boolean().default(false),
});
export type GetUserNotificationsSchema = z.infer<typeof getUserNotificationsSchema>;

export const upsertNotificationSettingInput = z.object({
  id: z.number().optional(),
  type: z.string(),
  userId: z.number(),
});
export type UpsertNotificationSettingInput = z.input<typeof upsertNotificationSettingInput>;

export const markReadNotificationInput = z.object({
  userId: z.number(),
  id: z.string().cuid().optional(),
  all: z.boolean().optional(),
});
export type MarkReadNotificationInput = z.infer<typeof markReadNotificationInput>;
