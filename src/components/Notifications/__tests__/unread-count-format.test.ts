import { describe, expect, it } from 'vitest';
import {
  applyMarkReadToCounts,
  formatBellCount,
  formatTabCount,
  formatUnreadCount,
} from '~/components/Notifications/notifications.utils';
import { NotificationCategory } from '~/server/common/enums';

const render = (counts: Record<string, number>, tab: string) => formatTabCount(tab, counts);

describe('formatUnreadCount', () => {
  it.each([
    [0, false, '0'],
    [999, false, '999'],
    [999, true, '999+'],
    [1000, false, '1k+'],
    [275840, true, '1k+'],
  ])('%i (floor: %s) renders %s', (count, isFloor, expected) => {
    expect(formatUnreadCount(count, isFloor)).toBe(expected);
  });
});

describe('a capped count after mark-read', () => {
  const capped = () => ({ all: 10001, update: 9984, milestone: 17, unreadCountsAreFloors: 1 });

  it('a decrement on a capped category still renders as capped', () => {
    const next = applyMarkReadToCounts(capped(), { id: 1, category: 'Update' });

    expect(render(next, NotificationCategory.Update)).toBe('1k+');
    expect(render(next, 'all')).toBe('1k+');
  });

  it('a decrement on a small floored category stays a floor', () => {
    const next = applyMarkReadToCounts(capped(), { id: 1, category: 'Milestone' });

    expect(render(next, NotificationCategory.Milestone)).toBe('16+');
  });

  it('never marks the announcements tab as a floor', () => {
    expect(render({ ...capped(), announcements: 3 }, 'announcements')).toBe('3');
  });

  it('the bell marks a floor below its own cap', () => {
    const next = applyMarkReadToCounts(capped(), { category: 'Update' });

    expect(formatBellCount(next)).toBe('17+');
    expect(formatBellCount(capped())).toBe('99+');
    expect(formatBellCount({ all: 17, unreadCountsAreFloors: 0 })).toBe('17');
  });

  it('mark all as read leaves exact zeroes, not floors', () => {
    const next = applyMarkReadToCounts(capped(), {});

    expect(render(next, 'all')).toBe('0');
  });
});
