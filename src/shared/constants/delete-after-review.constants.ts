/**
 * What an owner is told when their delete waits on a review, and only when they can already see it
 * (`childSafetyVisibleCase`). One text for every case.
 */
export const DELETE_AFTER_REVIEW_MESSAGE =
  'This item will be deleted after our internal review is complete.';

/**
 * What an owner is told after every other delete of their own image or post, whether it went or a
 * hold kept it: the same answer either way, so the answer never says that a hold applies.
 */
export const DELETE_PROCESSING_MESSAGE = 'Deletion is processing and may take a little while.';
