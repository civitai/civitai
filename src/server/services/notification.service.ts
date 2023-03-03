import { Prisma } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import {
  GetUserNotificationsSchema,
  MarkReadNotificationInput,
  ToggleNotificationSettingInput,
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
  const notificationQuery = dbRead.notification.findMany({
    take: limit,
    cursor: cursor ? { id: cursor } : undefined,
    where,
    select,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });

  if (count) {
    const [items, count] = await dbRead.$transaction([
      notificationQuery,
      dbRead.notification.count({ where }),
    ]);

    return { items, count };
  }

  const items = await notificationQuery;

  return { items };
};

export const createUserNotificationSetting = async ({
  toggle,
  ...data
}: ToggleNotificationSettingInput) => {
  return dbWrite.userNotificationSettings.create({ data });
};

export const updateUserNoticationById = ({
  id,
  userId,
  data,
  all = false,
}: MarkReadNotificationInput & { data: Prisma.NotificationUpdateInput }) => {
  return dbWrite.notification.updateMany({
    where: { id: !all ? id : undefined, userId, viewedAt: { equals: null } },
    data,
  });
};

export const deleteUserNotificationSetting = ({ type, userId }: ToggleNotificationSettingInput) => {
  return dbWrite.userNotificationSettings.deleteMany({ where: { type, userId } });
};

export const createNotification = (data: Prisma.NotificationCreateArgs['data']) => {
  return dbWrite.notification.create({ data });
};
