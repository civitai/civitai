/**
 * The notice for a delete that waits on a review the owner can already see (`childSafetyVisibleCase`):
 * the reply to a moderator's delete, and the owner's own image page. One text for every case.
 */
export const DELETE_AFTER_REVIEW_MESSAGE =
  'This item will be deleted after our internal review is complete.';

/**
 * The reply to every member's delete of their own image or post, whether it went or any hold kept
 * it, so the reply never says that a hold applies.
 */
export const DELETE_PROCESSING_MESSAGE = 'Deletion is processing and may take a little while.';
