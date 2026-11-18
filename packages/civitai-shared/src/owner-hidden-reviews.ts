/** Review holds not served even to the image's owner; their other review states stay visible to them. */
export const OWNER_HIDDEN_REVIEWS = ['csam', 'minor'];

/** Whether a row's review state is an owner-hidden hold. */
export const isHeldForReview = (needsReview: string | null | undefined) =>
  !!needsReview && OWNER_HIDDEN_REVIEWS.includes(needsReview);
