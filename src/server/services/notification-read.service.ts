import { notifications } from '~/server/notifications/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import type { GetUserNotificationsSchema } from '~/server/schema/notification.schema';
import { getUserNotificationCount } from '~/server/services/notification.service';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

// The notification READ path, apart from notification.service: the detail fetchers it enriches
// rows with read many services, and every module that only CREATES a notification imports
// notification.service, so keeping them here stops that whole graph loading with it.

export async function getUserNotifications({
  limit = DEFAULT_PAGE_SIZE,
  cursor,
  userId,
  category,
  count = false,
  unread = false,
  showSfwFace,
}: Partial<GetUserNotificationsSchema> & {
  userId: number;
  count?: boolean;
  showSfwFace: boolean;
}) {
  // Base rows come from the app (notif DB); enrichment reads the MAIN db, so it stays here.
  const items = await notifications.queryNotifications({ userId, limit, cursor, category, unread });
  await populateNotificationDetails(items, { showSfwFace });

  if (count) return { items, count: await getUserNotificationCount({ userId, unread }) };

  return { items };
}
