import { describe, expect, it } from 'vitest';
import { NotificationCategory } from '~/server/common/enums';
import { summarizeUnreadCounts } from '~/server/utils/unread-notification-counts';

describe('summarizeUnreadCounts', () => {
  it('sums the categories into all and marks exact counts', () => {
    expect(
      summarizeUnreadCounts([
        { category: NotificationCategory.Update, count: 8 },
        { category: NotificationCategory.Milestone, count: 1 },
      ])
    ).toEqual({ all: 9, update: 8, milestone: 1, unreadCountsAreFloors: 0 });
  });

  it('flags the payload when the counts are floors', () => {
    expect(
      summarizeUnreadCounts([{ category: NotificationCategory.Update, count: 10001, floor: true }])
        .unreadCountsAreFloors
    ).toBe(1);
  });
});
