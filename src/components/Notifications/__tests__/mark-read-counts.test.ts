import { describe, expect, it } from 'vitest';
import {
  applyMarkReadToCounts,
  NON_CATEGORY_COUNT_KEYS,
} from '~/components/Notifications/notifications.utils';

/**
 * The `checkNotifications` payload carries notification category counts AND
 * `pendingPlacements`, which is not one. "Mark all as read" zeroed everything it
 * could see, including the placement count — and since that query is
 * `staleTime: Infinity` with no invalidation, the sticker badge stayed gone for
 * the rest of the session.
 *
 * For an owner without the `stickerPlacement` flag the menu entry is gated on a
 * nonzero count, so the wipe removed the entry outright: one click on an
 * unrelated button deleted the discoverability the whole feature exists to add.
 */
const counts = () => ({
  all: 7,
  comment: 4,
  buzz: 3,
  pendingPlacements: 12,
});

describe('mark all as read', () => {
  it('zeroes every notification category', () => {
    const next = applyMarkReadToCounts(counts(), {});

    expect(next.all).toBe(0);
    expect(next.comment).toBe(0);
    expect(next.buzz).toBe(0);
  });

  it('leaves pendingPlacements alone — it is not a notification', () => {
    // The regression. Reading someone's notifications does not review their
    // pending placements, and nothing refetches this query to correct it.
    expect(applyMarkReadToCounts(counts(), {}).pendingPlacements).toBe(12);
  });
});

describe('mark one category read', () => {
  it('zeroes that category and subtracts it from all', () => {
    const next = applyMarkReadToCounts(counts(), { category: 'Comment' });

    expect(next.comment).toBe(0);
    expect(next.all).toBe(3);
  });

  it('cannot select the placement count, whatever the category is called', () => {
    // The category branch lowercases before matching, and the key is camelCase.
    // That is an accident, not a design — this pins the behaviour it buys so a
    // rename of the field fails here rather than silently subtracting a
    // placement count out of the bell.
    const next = applyMarkReadToCounts(counts(), { category: 'pendingPlacements' });

    expect(next.pendingPlacements).toBe(12);
    expect(next.all).toBe(7);
  });
});

describe('mark a single notification read', () => {
  it('decrements all and that category only', () => {
    const next = applyMarkReadToCounts(counts(), { id: 1, category: 'Comment' });

    expect(next.all).toBe(6);
    expect(next.comment).toBe(3);
    expect(next.pendingPlacements).toBe(12);
  });

  it('never clamps a category below zero', () => {
    const next = applyMarkReadToCounts(
      { all: 0, comment: 0, pendingPlacements: 5 },
      {
        id: 1,
        category: 'Comment',
      }
    );

    expect(next.all).toBe(0);
    expect(next.comment).toBe(0);
  });
});

describe('the guard set', () => {
  it('names the key the loops skip', () => {
    // If a future payload gains another non-category count, adding it here is
    // the whole fix — this asserts the set is the mechanism rather than a
    // stray constant.
    expect(NON_CATEGORY_COUNT_KEYS.has('pendingPlacements')).toBe(true);
    expect(NON_CATEGORY_COUNT_KEYS.has('comment')).toBe(false);
  });
});
