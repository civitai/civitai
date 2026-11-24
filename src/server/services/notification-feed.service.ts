import { notifications } from '~/server/notifications/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import type { GetUserNotificationsSchema } from '~/server/schema/notification.schema';
import { getUserNotificationCount } from '~/server/services/notification.service';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

/**
 * Kept out of `notification.service`, which most notification senders import: importing the detail
 * fetchers there put that service in the image.service import cycle.
 */
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
  // Base rows come from the notifications app; enrichment reads the MAIN db, so it runs here.
  const items = await notifications.queryNotifications({ userId, limit, cursor, category, unread });
  await populateNotificationDetails(items, { showSfwFace });

  if (count) return { items, count: await getUserNotificationCount({ userId, unread }) };

  return { items };
}
