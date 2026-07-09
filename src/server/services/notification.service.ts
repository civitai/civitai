import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { NotificationsClientError } from '@civitai/notifications';
import type { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { notifications } from '~/server/notifications/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import {
  notificationSingleRowFull,
  type GetUserNotificationsSchema,
  type MarkReadNotificationInput,
  type ToggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const createNotificationPendingRow = notificationSingleRowFull
  .omit({ userId: true })
  .extend({
    userId: z.number().optional(),
    userIds: z.array(z.number()).optional(),
    debounceSeconds: z.number().optional(),
  });
export type CreateNotificationPendingRow = z.infer<typeof createNotificationPendingRow>;

// Create/read/mark all go through the notifications app (apps/notifications) via
// @civitai/notifications — the monolith no longer touches the notification DB. The settings opt-out
// filter (create), the fan-out worker, the read/count/mark queries, and the per-user unread cache all
// live in that app now; the monolith keeps only the main-DB `details` enrichment + the
// UserNotificationSettings writes below.

export const createNotification = async (data: CreateNotificationPendingRow) => {
  try {
    await notifications.createNotification(data);
  } catch (e) {
    // Client errors are logged centrally (notifications-request-failed); best-effort, so swallow them and
    // only surface a non-request error (e.g. schema validation).
    if (e instanceof NotificationsClientError) return;
    const error = e as Error;
    logToAxiom(
      {
        type: 'warning',
        name: 'Failed to create notification',
        details: { key: data.key },
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'notifications'
    ).catch();
  }
};

export async function getUserNotifications({
  limit = DEFAULT_PAGE_SIZE,
  cursor,
  userId,
  category,
  count = false,
  unread = false,
}: Partial<GetUserNotificationsSchema> & {
  userId: number;
  count?: boolean;
}) {
  // Base rows come from the app (notif DB); enrichment reads the MAIN db, so it stays here.
  const items = await notifications.queryNotifications({ userId, limit, cursor, category, unread });
  await populateNotificationDetails(items);

  if (count) return { items, count: await getUserNotificationCount({ userId, unread }) };

  return { items };
}

export async function getUserNotificationCount({
  userId,
  unread,
  category,
}: {
  userId: number;
  unread: boolean;
  category?: NotificationCategory;
}) {
  return notifications.countNotifications({ userId, unread, category });
}

export const markNotificationsRead = async ({
  id,
  userId,
  all = false,
  category,
}: MarkReadNotificationInput & { userId: number }) => {
  // Best-effort: the UI already marked read optimistically, so a transient failure must not surface as a
  // tRPC error. Client errors log centrally; only a non-request error logs here. `id` is a bigint
  // (UserNotification.id is int4) — narrow to a JSON-safe number.
  try {
    await notifications.markNotificationsRead({
      userId,
      id: id != null ? Number(id) : undefined,
      all,
      category,
    });
  } catch (e) {
    if (e instanceof NotificationsClientError) return;
    const error = e as Error;
    logToAxiom(
      {
        type: 'warning',
        name: 'Failed to mark notifications read',
        details: { userId, all, category },
        message: error.message,
      },
      'notifications'
    ).catch();
  }
};

export const createUserNotificationSetting = async ({
  type,
  userId,
}: ToggleNotificationSettingInput & { userId: number }) => {
  const values = type.map((t) => Prisma.sql`(${t}, ${userId})`);
  return dbWrite.$executeRaw`
    INSERT INTO "UserNotificationSettings" ("type", "userId")
    VALUES
    ${Prisma.join(values)}
    ON CONFLICT
    DO NOTHING
  `;
};

export const deleteUserNotificationSetting = async ({
  type,
  userId,
}: ToggleNotificationSettingInput & { userId: number }) => {
  return dbWrite.userNotificationSettings.deleteMany({ where: { type: { in: type }, userId } });
};
