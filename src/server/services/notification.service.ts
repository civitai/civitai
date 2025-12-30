import { Prisma } from '@prisma/client';
import * as z from 'zod';
import type { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { notifDbRead, notifDbWrite } from '~/server/db/notifDb';
import { logToAxiom } from '~/server/logging/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import type { NotificationCategoryCount } from '~/server/notifications/notification-cache';
import { notificationCache } from '~/server/notifications/notification-cache';
import {
  notificationSingleRowFull,
  type GetUserNotificationsSchema,
  type MarkReadNotificationInput,
  type ToggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

type NotificationsRaw = {
  id: number;
  type: string;
  category: NotificationCategory;
  details: MixedObject;
  createdAt: Date;
  read: boolean;
};

export const createNotificationPendingRow = notificationSingleRowFull
  .omit({ userId: true })
  .extend({
    userId: z.number().optional(),
    userIds: z.array(z.number()).optional(),
    debounceSeconds: z.number().optional(),
  });
export type CreateNotificationPendingRow = z.infer<typeof createNotificationPendingRow>;

export const createNotification = async (data: CreateNotificationPendingRow) => {
  try {
    if (!data.userIds) data.userIds = [];
    if (data.userId) data.userIds.push(data.userId);
    if (data.userIds.length === 0) return;

    const userNotificationSettings = await dbRead.userNotificationSettings.findMany({
      where: { userId: { in: data.userIds }, type: data.type },
    });
    // TODO handle defaultDisabled
    const targets = data.userIds.filter(
      (x) => !userNotificationSettings.some((y) => y.userId === x) && x !== -1
    );
    // If the user has this notification type disabled, don't create a notification.
    if (targets.length === 0) return;

    const insResp = await notifDbWrite.cancellableQuery(Prisma.sql`
      INSERT INTO "PendingNotification" (key, type, category, users, details, "debounceSeconds")
      VALUES (
        ${data.key},
        ${data.type},
        ${data.category}::"NotificationCategory",
        ${'{' + targets.join(',') + '}'},
        ${JSON.stringify(data.details)}::jsonb,
        ${data.debounceSeconds}
      )
      ON CONFLICT (key)
      DO UPDATE SET "users" = excluded."users", "lastTriggered" = NOW()
    `);
    await insResp.result();
  } catch (e) {
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
  const AND = [Prisma.sql`un."userId" = ${userId}`];
  if (unread) AND.push(Prisma.sql`un.viewed IS FALSE`);
  if (category) AND.push(Prisma.sql`n.category = ${category}::"NotificationCategory"`);

  if (cursor) AND.push(Prisma.sql`un."createdAt" < ${cursor}`);
  // else AND.push(Prisma.sql`un."createdAt" > NOW() - interval '1 month'`);

  const query = await notifDbRead.cancellableQuery<NotificationsRaw>(Prisma.sql`
    SELECT
      un.id,
      n.type,
      n.category,
      n.details,
      un."createdAt",
      un.viewed AS read
    FROM
      "UserNotification" un
        JOIN "Notification" n ON n."id" = un."notificationId"
    WHERE
      ${Prisma.join(AND, ' AND ')}
    ORDER BY un."createdAt" DESC
    LIMIT ${limit}
  `);
  const items = await query.result();

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
  const cachedCount = await notificationCache.getUser(userId);
  if (cachedCount) return cachedCount;

  const AND = [Prisma.sql`un."userId" = ${userId}`];
  if (unread) AND.push(Prisma.sql`un.viewed IS FALSE`);
  // else AND.push(Prisma.sql`un."createdAt" > NOW() - interval '1 month'`);

  // this seems unused
  if (category) AND.push(Prisma.sql`n.category = ${category}::"NotificationCategory"`);

  const query = await notifDbRead.cancellableQuery<NotificationCategoryCount>(Prisma.sql`
    SELECT
      n.category,
      COUNT(*) AS count
    FROM
      "UserNotification" un
        JOIN "Notification" n ON n."id" = un."notificationId"
    WHERE
      ${Prisma.join(AND, ' AND ')}
    GROUP BY category
  `);

  const result = await query.result();
  await notificationCache.setUser(userId, result);
  return result;
}

export const markNotificationsRead = async ({
  id,
  userId,
  all = false,
  category,
}: MarkReadNotificationInput & { userId: number }) => {
  if (all) {
    if (category) {
      // Join only needed when filtering by category
      await notifDbWrite.query(Prisma.sql`
        UPDATE "UserNotification" un
        SET
          viewed = TRUE
        FROM
          "Notification" n
        WHERE
          un."notificationId" = n.id
          AND un."userId" = ${userId}
          AND un.viewed IS FALSE
          AND n."category" = ${category}::"NotificationCategory"
      `);
      await notificationCache.clearCategory(userId, category);
    } else {
      // No join needed - faster query
      await notifDbWrite.query(Prisma.sql`
        UPDATE "UserNotification" un
        SET
          viewed = TRUE
        WHERE
          un."userId" = ${userId}
          AND un.viewed IS FALSE
      `);
      await notificationCache.bustUser(userId);
    }
  } else {
    const resp = await notifDbWrite.query(Prisma.sql`
      UPDATE "UserNotification" un
      SET
        viewed = TRUE
      WHERE
          id = ${id}
      AND viewed IS FALSE
    `);

    // Update cache if the notification was marked read
    if (resp.rowCount) {
      const catQuery = await notifDbRead.cancellableQuery<{
        category: NotificationCategory;
      }>(Prisma.sql`
        SELECT
          n.category
        FROM
          "UserNotification" un
            JOIN "Notification" n ON un."notificationId" = n.id
        WHERE
          un.id = ${id}
      `);
      const catData = await catQuery.result();
      if (catData && catData.length)
        await notificationCache.decrementUser(userId, catData[0].category);
    }
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
