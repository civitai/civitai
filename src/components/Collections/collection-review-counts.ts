import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

/**
 * Moving the pending-review badges when a reviewer decides items.
 *
 * Pure, and separate from the mutations that call them, because the counts live in a query with
 * `staleTime: Infinity` — a decrement that is wrong stays wrong until a full page load, and a
 * decrement written inline in a `useMutation` option cannot be reached by a test at all.
 *
 * Both decrements floor at zero. Negative is reachable: two tabs on the same queue, or a bulk
 * action on rows a co-manager already cleared.
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
      pendingReviewCount: Math.max(0, collection.pendingReviewCount - reviewed),
    };
  });
}
