import { describe, expect, it } from 'vitest';
import {
  applyClearedToCounts,
  shouldMarkImageMilestonesRead,
} from '~/components/Notifications/notifications.utils';

describe('viewing your own image clears its milestone notifications', () => {
  it('asks only for an owned image, while milestones are unread, once per image', () => {
    const asked = new Set([42]);
    expect(shouldMarkImageMilestonesRead(43, 3, asked)).toBe(true);
    expect(shouldMarkImageMilestonesRead(undefined, 3, asked)).toBe(false); // not the owner
    expect(shouldMarkImageMilestonesRead(43, 0, asked)).toBe(false); // nothing unread
    expect(shouldMarkImageMilestonesRead(42, 3, asked)).toBe(false); // already asked this page load
  });

  it('takes the cleared count off its category and the bell, and nothing else', () => {
    const counts = { all: 9, milestone: 5, comment: 4, pendingPlacements: 2 };
    expect(applyClearedToCounts(counts, [{ category: 'Milestone', count: 2 }])).toEqual({
      all: 7,
      milestone: 3,
      comment: 4,
      pendingPlacements: 2,
    });
  });
});
