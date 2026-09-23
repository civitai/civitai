import { CollectionContributorPermission, CollectionItemStatus } from '~/shared/utils/prisma/enums';

/**
 * The `collection.getAllUser` input shared by every reader and writer of the pending-review
 * counts (the sidebar, `/collections`, and the cache decrement below). A React Query cache key
 * includes the input, so a caller using a different literal here fetches — and caches — a
 * separate, un-decremented copy of the same list.
 */
export const MY_COLLECTIONS_LIST_INPUT = {
  permission: CollectionContributorPermission.VIEW,
  withPendingReviewCounts: true,
} as const;

/**
 * Moving the pending-review badges when a reviewer decides items.
 *
 * Pure, and separate from the mutations that call them, because a decrement written inline in a
 * `useMutation` option cannot be reached by a test at all.
 */

/**
 * How many of the rows just acted on were actually waiting for review.
 *
 * Not `ids.length`: a contest collection's review page has status chips, so a reviewer can select
 * already-decided rows and re-decide them. Those were never in the review queue, and counting them
 * decrements a badge that never held them.
 */
export function countPendingReviewItems<
  T extends { id: number; status?: CollectionItemStatus | null }
>(items: T[], actedOnIds: number[]): number {
  return items.filter(
    (item) => actedOnIds.includes(item.id) && item.status === CollectionItemStatus.REVIEW
  ).length;
}

export function decrementPendingReviewTotal<T extends { pendingCollectionReviews: number }>(
  old: T | undefined,
  reviewed: number
): T | undefined {
  if (!old) return old;

  return {
    ...old,
    // Floors at zero — negative is reachable: two tabs on the same queue, or a bulk action on
    // rows a co-manager already cleared.
    pendingCollectionReviews: Math.max(0, old.pendingCollectionReviews - reviewed),
  };
}

export function decrementPendingReviewForCollection<
  T extends { id: number; pendingReviewCount?: number }
>(old: T[] | undefined, collectionId: number, reviewed: number): T[] | undefined {
  if (!old) return old;

  return old.map((collection) => {
    // A row from an unflagged `getAllUser` call carries no count. Writing one in would badge a
    // surface that deliberately has none.
    if (collection.id !== collectionId || collection.pendingReviewCount === undefined)
      return collection;

    return {
      ...collection,
      // Floors at zero, same reasoning as decrementPendingReviewTotal above.
      pendingReviewCount: Math.max(0, collection.pendingReviewCount - reviewed),
    };
  });
}
