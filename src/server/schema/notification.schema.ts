import * as z from 'zod';
import { CURSOR_MAX_DATE, CURSOR_MIN_DATE, parseNotificationCursor } from '@civitai/notifications';
import { NotificationCategory } from '~/server/common/enums';

import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getUserNotificationsSchema = getAllQuerySchema.extend({
  // A Date is a cursor issued before the keyset cursor, still held by an open tab.
  cursor: z.union([
    z.date().min(CURSOR_MIN_DATE).max(CURSOR_MAX_DATE),
    z.string().transform((value, ctx) => {
      const cursor = parseNotificationCursor(value);
      if (!cursor) {
        ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
        return z.NEVER;
      }
      return cursor;
    }),
  ]),
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

/**
 * The service worker's `pushsubscriptionchange` payload. Same shape as a subscribe, plus the
 * endpoint the push service rotated away from so the stale row can be reaped in the same request
 * — left behind it survives until 10 consecutive delivery failures or the 180-day cleanup job.
 * Not folded into `upsertPushSubscriptionInput`: tRPC's `subscribePush` has no old endpoint and
 * must not grow a field it can never populate.
 */
export const resubscribePushInput = upsertPushSubscriptionInput.extend({
  oldEndpoint: z.string().min(1).nullish(),
});
export type ResubscribePushInput = z.infer<typeof resubscribePushInput>;

export const deletePushSubscriptionInput = z.object({
  endpoint: z.string().min(1),
});
export type DeletePushSubscriptionInput = z.infer<typeof deletePushSubscriptionInput>;

export const togglePushSettingInput = z.object({
  type: z.string().array().min(1),
  enabled: z.boolean(),
});
export type TogglePushSettingInput = z.infer<typeof togglePushSettingInput>;

export const toggleEmailSettingInput = z.object({
  type: z.string().array().min(1),
  enabled: z.boolean(),
});
export type ToggleEmailSettingInput = z.infer<typeof toggleEmailSettingInput>;

export const markReadNotificationInput = z.object({
  id: z.coerce.bigint().optional(),
  all: z.boolean().optional(),
  category: z.enum(NotificationCategory).nullish(),
});
export type MarkReadNotificationInput = z.infer<typeof markReadNotificationInput>;

export const markImageMilestonesReadInput = z.object({ imageId: z.number().int().positive() });
export type MarkImageMilestonesReadInput = z.infer<typeof markImageMilestonesReadInput>;

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
