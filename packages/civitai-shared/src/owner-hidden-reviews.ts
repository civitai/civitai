/**
 * Review holds not served to anyone but moderators and the image's owner. The owner sees their own
 * held image only on owner reads that pass the owner's id (`notHeldForReviewSql(ownerId)`).
 */
export const OWNER_HIDDEN_REVIEWS = ['csam', 'minor'];

/** Whether a row's review state is an owner-hidden hold. */
export const isHeldForReview = (needsReview: string | null | undefined) =>
  !!needsReview && OWNER_HIDDEN_REVIEWS.includes(needsReview);
