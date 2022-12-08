import { Prisma } from '@prisma/client';

import { prisma } from '~/server/db/client';
import {
  GetUserNotificationsSchema,
  MarkReadNotificationInput,
  UpsertNotificationSettingInput,
} from '~/server/schema/notification.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getUserNotifications = async <TSelect extends Prisma.NotificationSelect>({
  limit = DEFAULT_PAGE_SIZE,
  cursor,
  userId,
  select,
  count = false,
  unread = false,
}: Partial<GetUserNotificationsSchema> & {
  userId: number;
  select: TSelect;
  count?: boolean;
}) => {
  const where: Prisma.NotificationWhereInput = {
    userId,
    viewedAt: unread ? { equals: null } : undefined,
  };
  const notificationQuery = prisma.notification.findMany({
    take: limit,
    cursor: cursor ? { id: cursor } : undefined,
    where,
    select,
    orderBy: { createdAt: 'desc' },
  });

  if (count) {
    const [items, count] = await Promise.all([
      notificationQuery,
      prisma.notification.count({ where }),
    ]);

    return { items, count };
  }

  const items = await notificationQuery;

  return { items };
};

export const createOrUpdateNotificationSetting = async ({
  id,
  ...data
}: UpsertNotificationSettingInput) => {
  return prisma.userNotificationSettings.upsert({
    where: { id: id ?? -1 },
    update: { ...data, disabledAt: new Date() },
    create: { ...data, disabledAt: new Date() },
  });
};

export const updateUserNoticationById = ({
  id,
  userId,
  data,
  all = false,
}: MarkReadNotificationInput & { data: Prisma.NotificationUpdateInput }) => {
  return prisma.notification.updateMany({
    where: { id: !all ? id : undefined, userId, viewedAt: { equals: null } },
    data,
  });
};
