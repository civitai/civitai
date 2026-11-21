/**
 * What an owner is told when their delete waits on a review, and only when they can already see it
 * (`childSafetyVisibleCase`). One text for every case.
 */
export const DELETE_AFTER_REVIEW_MESSAGE =
  'This item will be deleted after our internal review is complete.';

/** What an owner is told when their delete waits on a report not yet sent. Never says why. */
export const DELETE_PROCESSING_MESSAGE = 'Deletion is processing and may take a little while.';

/** The text for a delete's pending notices, the review one first; undefined when there are none. */
export function deleteNoticeText(notices: Iterable<'review' | 'processing'>) {
  const all = new Set(notices);
  if (all.has('review')) return DELETE_AFTER_REVIEW_MESSAGE;
  if (all.has('processing')) return DELETE_PROCESSING_MESSAGE;
  return undefined;
}
