import type { NotificationCategory } from '~/server/common/enums';

type UnreadCategoryCount = { category: NotificationCategory; count: number; floor?: boolean };

export function summarizeUnreadCounts(rows: UnreadCategoryCount[]) {
  const counts = { all: 0 } as Record<Lowercase<NotificationCategory> | 'all', number>;
  for (const { category, count } of rows) {
    counts[category.toLowerCase() as Lowercase<NotificationCategory>] = Number(count);
    counts.all += Number(count);
  }
  return {
    ...counts,
    // A number, not a boolean: the client treats this payload as a Record<string, number> (see
    // applyMarkReadToCounts). Left out of NON_CATEGORY_COUNT_KEYS on purpose: mark-all-read zeroes every
    // count, and a zero is exact.
    unreadCountsAreFloors: rows.some((row) => row.floor) ? 1 : 0,
  };
}
