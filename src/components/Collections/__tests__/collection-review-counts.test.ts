import { describe, expect, it } from 'vitest';
import {
  countPendingReviewItems,
  decrementPendingReviewForCollection,
  decrementPendingReviewTotal,
} from '~/components/Collections/collection-review-counts';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

describe('decrementPendingReviewTotal', () => {
  it('subtracts the number just reviewed', () => {
    const next = decrementPendingReviewTotal({ all: 3, pendingCollectionReviews: 7 }, 2);

    expect(next?.pendingCollectionReviews).toBe(5);
  });

  it('leaves every other key untouched', () => {
    // The badge this moves shares a payload with the notification bell. A spread
    // that dropped a key here would empty the bell on an unrelated action.
    const next = decrementPendingReviewTotal({ all: 3, pendingCollectionReviews: 7 }, 2);

    expect(next?.all).toBe(3);
  });

  it('floors at zero rather than going negative', () => {
    // Reachable for real: two tabs reviewing the same queue, or a bulk action on
    // a queue that a co-manager already partly cleared.
    const next = decrementPendingReviewTotal({ pendingCollectionReviews: 1 }, 5);

    expect(next?.pendingCollectionReviews).toBe(0);
  });

  it('is a no-op on an empty cache', () => {
    expect(decrementPendingReviewTotal(undefined, 3)).toBeUndefined();
  });
});

describe('decrementPendingReviewForCollection', () => {
  const rows = () => [
    { id: 1, pendingReviewCount: 4 },
    { id: 2, pendingReviewCount: 1 },
    { id: 3 },
  ];

  it('subtracts from the named collection only', () => {
    const next = decrementPendingReviewForCollection(rows(), 1, 3);

    expect(next?.[0].pendingReviewCount).toBe(1);
    expect(next?.[1].pendingReviewCount).toBe(1);
  });

  it('floors at zero rather than going negative', () => {
    const next = decrementPendingReviewForCollection(rows(), 2, 5);

    expect(next?.[1].pendingReviewCount).toBe(0);
  });

  it('leaves a row that never carried a count alone', () => {
    // A row from an unflagged call has no `pendingReviewCount`. Writing one in
    // would draw a badge on a surface that deliberately has none.
    const next = decrementPendingReviewForCollection(rows(), 3, 2);

    expect(next?.[2].pendingReviewCount).toBeUndefined();
  });

  it('is a no-op for a collection that is not in the list', () => {
    const next = decrementPendingReviewForCollection(rows(), 999, 2);

    expect(next).toEqual(rows());
  });

  it('is a no-op on an empty cache', () => {
    expect(decrementPendingReviewForCollection(undefined, 1, 2)).toBeUndefined();
  });
});

describe('countPendingReviewItems', () => {
  const items = () => [
    { id: 1, status: CollectionItemStatus.REVIEW },
    { id: 2, status: CollectionItemStatus.ACCEPTED },
    { id: 3, status: CollectionItemStatus.REVIEW },
    { id: 4, status: CollectionItemStatus.REJECTED },
  ];

  it('counts only the acted-on rows that were still pending', () => {
    // 🔴 The whole point. A contest collection's review page has status chips, so
    // a reviewer can select ACCEPTED and REJECTED rows and re-decide them. Those
    // were never in the review queue and must not move the badge. Acting on all
    // four rows must count 2, not 4.
    expect(countPendingReviewItems(items(), [1, 2, 3, 4])).toBe(2);
  });

  it('counts nothing when every acted-on row was already decided', () => {
    expect(countPendingReviewItems(items(), [2, 4])).toBe(0);
  });

  it('ignores rows that were not acted on', () => {
    expect(countPendingReviewItems(items(), [1])).toBe(1);
  });

  it('is zero for an empty selection and an empty list', () => {
    expect(countPendingReviewItems(items(), [])).toBe(0);
    expect(countPendingReviewItems([], [1, 2])).toBe(0);
  });
});
