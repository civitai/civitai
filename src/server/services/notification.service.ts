import { NotificationCategory, Prisma } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import {
  GetUserNotificationsSchema,
  MarkReadNotificationInput,
  ToggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

type NotificationsRaw = {
  id: string;
  type: string;
  details: MixedObject;
  createdAt: Date;
  read: boolean;
  category: NotificationCategory;
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
  const AND = [Prisma.sql`n."userId" = ${userId}`];
  if (unread) AND.push(Prisma.sql`nv.id IS NULL`);
  if (cursor) AND.push(Prisma.sql`n."createdAt" < ${cursor}`);
  else AND.push(Prisma.sql`n."createdAt" > NOW() - interval '1 month'`);

  if (category) AND.push(Prisma.sql`n.category = ${category}::"NotificationCategory"`);

  const items = await dbRead.$queryRaw<NotificationsRaw[]>`
    SELECT n."id", "type", "category", "details", "createdAt", nv."id" IS NOT NULL as read
    FROM "Notification" n
    LEFT JOIN "NotificationViewed" nv ON n."id" = nv."id" AND nv."userId" = ${userId}
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `;

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
  const AND = [Prisma.sql`"userId" = ${userId}`];
  if (unread)
    AND.push(
      Prisma.sql`"id" NOT IN (SELECT id FROM "NotificationViewed" WHERE "userId" = ${userId})`
    );
  else AND.push(Prisma.sql`"createdAt" > NOW() - interval '1 month'`);

  if (category) AND.push(Prisma.sql`category = ${category}::"NotificationCategory"`);

  const result = await dbRead.$queryRaw<{ category: NotificationCategory; count: number }[]>`
    SELECT
      category,
      COUNT(*) as count
    FROM "Notification"
    WHERE ${Prisma.join(AND, ' AND ')}
    GROUP BY category
  `;

  return result.map(({ category, count }) => ({ category, count: Number(count) }));
}

export const createUserNotificationSetting = async ({
  type,
  userId,
}: ToggleNotificationSettingInput & { userId: number }) => {
  const values = type.map((t) => Prisma.sql`(${t}, ${userId})`);
  return dbWrite.$executeRaw`
    INSERT INTO "UserNotificationSettings" ("type", "userId") VALUES
    ${Prisma.join(values)}
    ON CONFLICT DO NOTHING
  `;
};

export const markNotificationsRead = ({
  id,
  userId,
  all = false,
}: MarkReadNotificationInput & { userId: number }) => {
  if (all) {
    return dbWrite.$executeRaw`
      INSERT INTO "NotificationViewed" ("id", "userId")
      SELECT "id", ${userId}
      FROM "Notification"
      WHERE "userId" = ${userId}
        AND "id" NOT IN (SELECT "id" FROM "NotificationViewed" WHERE "userId" = ${userId})
    `;
  } else {
    return dbWrite.$executeRaw`
      INSERT INTO "NotificationViewed" ("id", "userId")
      VALUES (${id}, ${userId})
      ON CONFLICT ("id") DO NOTHING
    `;
  }
};

export const deleteUserNotificationSetting = ({
  type,
  userId,
}: ToggleNotificationSettingInput & { userId: number }) => {
  return dbWrite.userNotificationSettings.deleteMany({ where: { type: { in: type }, userId } });
};

export const createNotification = async (data: Prisma.NotificationCreateArgs['data']) => {
  const userNotificationSettings = await dbWrite.userNotificationSettings.findFirst({
    where: { userId: data.userId, type: data.type },
  });
  // If the user has this notification type disabled, don't create a notification.
  if (!!userNotificationSettings?.disabledAt) return;

  if (data.id) {
    return dbWrite.$executeRaw`
      INSERT INTO "Notification" ("id", "userId", "type", "details", "category")
      VALUES (
        ${data.id},
        ${data.userId},
        ${data.type},
        ${JSON.stringify(data.details)}::jsonb,
        ${data.category}::"NotificationCategory"
      )
      ON CONFLICT ("id") DO NOTHING
    `;
  }

  return dbWrite.notification.create({ data });
};
