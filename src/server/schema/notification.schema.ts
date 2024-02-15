import { NotificationCategory } from '@prisma/client';
import { z } from 'zod';

import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getUserNotificationsSchema = getAllQuerySchema.extend({
  cursor: z.date(),
  unread: z.boolean().default(false),
  category: z.nativeEnum(NotificationCategory).nullish(),
});
export type GetUserNotificationsSchema = z.infer<typeof getUserNotificationsSchema>;

export const toggleNotificationSettingInput = z.object({
  toggle: z.boolean(),
  type: z.string().array(),
});
export type ToggleNotificationSettingInput = z.input<typeof toggleNotificationSettingInput>;

export const markReadNotificationInput = z.object({
  id: z.string().optional(),
  all: z.boolean().optional(),
  category: z.nativeEnum(NotificationCategory).nullish(),
});
export type MarkReadNotificationInput = z.infer<typeof markReadNotificationInput>;
