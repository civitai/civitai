import { describe, expect, it } from 'vitest';
import { OVERDUE_ITEM_DAYS, isOverdue } from '../queue-thresholds';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86_400_000;

describe('isOverdue', () => {
  it('is false up to and including the threshold, true one millisecond past it', () => {
    const atThreshold = new Date(NOW - OVERDUE_ITEM_DAYS * DAY);

    expect(isOverdue(atThreshold, NOW)).toBe(false);
    expect(isOverdue(new Date(atThreshold.getTime() - 1), NOW)).toBe(true);
  });

  it('reads the ISO string a load returns the same as a Date', () => {
    expect(isOverdue(new Date(NOW - 8 * DAY).toISOString(), NOW)).toBe(true);
    expect(isOverdue(new Date(NOW - DAY).toISOString(), NOW)).toBe(false);
  });
});
