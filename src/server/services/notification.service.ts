import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { NotificationsClientError } from '@civitai/notifications';
import type { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { notifications } from '~/server/notifications/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import { DEFAULT_PUSH_TYPES } from '~/server/notifications/push.constants';
import { isPushableNotificationType } from '~/server/notifications/utils.notifications';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import {
  notificationSingleRowFull,
  type DeletePushSubscriptionInput,
  type GetUserNotificationsSchema,
  type MarkReadNotificationInput,
  type ToggleNotificationSettingInput,
  type TogglePushSettingInput,
  type UpsertPushSubscriptionInput,
} from '~/server/schema/notification.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const createNotificationPendingRow = notificationSingleRowFull
  .omit({ userId: true })
  .extend({
    userId: z.number().optional(),
    userIds: z.array(z.number()).optional(),
    debounceSeconds: z.number().optional(),
  })
  // Mirrors the same refine on @civitai/notifications' copy. Without it, callers that validate against
  // THIS schema (e.g. /api/mod/send-mod-notification) accept the pair, then the package schema rejects it
  // inside createNotification below — which logs and swallows, so the request 200s and nothing sends.
  .refine((row) => !(row.dedupeKey && row.debounceSeconds !== undefined), {
    message: 'dedupeKey is not supported on debounced notifications',
    path: ['dedupeKey'],
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
  // Unread counts drive a polled badge, so a transient notifications-service failure must degrade to
  // zero rather than fail the request — the next poll corrects it. Mirrors markNotificationsRead.
  // Deliberately NOT applied to the notification LIST: an empty list misrepresents the user's data,
  // where a stale-zero badge only under-reports for one poll interval.
  try {
    return await notifications.countNotifications({ userId, unread, category });
  } catch (e) {
    if (e instanceof NotificationsClientError) return [];
    throw e;
  }
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

export const upsertPushSubscription = async ({
  userId,
  endpoint,
  keys,
  userAgent,
}: UpsertPushSubscriptionInput & { userId: number; userAgent?: string }) => {
  await dbWrite.$transaction(async (tx) => {
    // Defaults materialize only while the user holds no other subscription — a grant from a second
    // browser must not re-insert types the user has since turned off (deleted).
    const existing = await tx.pushSubscription.count({ where: { userId } });
    await tx.pushSubscription.upsert({
      where: { endpoint },
      // An endpoint can resurface under a different account (same browser, new login) — the upsert
      // reassigns it, and resets the failure streak since the browser just proved it live.
      update: {
        userId,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent,
        lastSeenAt: new Date(),
        failureCount: 0,
      },
      create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent },
    });
    if (existing === 0 && DEFAULT_PUSH_TYPES.length > 0) {
      await tx.userPushSetting.createMany({
        data: DEFAULT_PUSH_TYPES.map((type) => ({ userId, type })),
        skipDuplicates: true,
      });
    }
  });
};

export const deletePushSubscription = async ({
  userId,
  endpoint,
}: DeletePushSubscriptionInput & { userId: number }) => {
  return dbWrite.pushSubscription.deleteMany({ where: { endpoint, userId } });
};

export const getUserPushSubscriptions = async ({ userId }: { userId: number }) => {
  return dbWrite.pushSubscription.findMany({
    where: { userId },
    select: {
      id: true,
      endpoint: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      lastSuccessAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
};

export const getUserPushSettings = async ({ userId }: { userId: number }) => {
  const rows = await dbWrite.userPushSetting.findMany({
    where: { userId },
    select: { type: true },
  });
  return rows.map((x) => x.type);
};

export const togglePushSetting = async ({
  type,
  enabled,
  userId,
}: TogglePushSettingInput & { userId: number }) => {
  if (enabled) {
    // Only the insert is gated — deleting a row is always allowed (a type could stop being
    // pushable after rows for it exist, and those must remain removable).
    const invalid = type.filter((t) => !isPushableNotificationType(t));
    if (invalid.length > 0)
      throw throwBadRequestError(`Not a push-capable notification type: ${invalid.join(', ')}`);
    await dbWrite.userPushSetting.createMany({
      data: type.map((t) => ({ userId, type: t })),
      skipDuplicates: true,
    });
  } else {
    await dbWrite.userPushSetting.deleteMany({ where: { userId, type: { in: type } } });
  }
};
