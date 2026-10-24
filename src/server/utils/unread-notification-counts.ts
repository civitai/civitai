import type { NotificationCategoryCount } from '@civitai/notifications';
import type { NotificationCategory } from '~/server/common/enums';

export function summarizeUnreadCounts(rows: NotificationCategoryCount[]) {
  const counts = { all: 0 } as Record<Lowercase<NotificationCategory> | 'all', number>;
  for (const { category, count } of rows) {
    counts[category.toLowerCase() as Lowercase<NotificationCategory>] = Number(count);
    counts.all += Number(count);
  }
  return { ...counts, unreadCountsAreFloors: rows.some((row) => row.floor) ? 1 : 0 };
}
