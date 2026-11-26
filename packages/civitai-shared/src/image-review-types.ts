/**
 * Every value a writer puts in `Image.needsReview`, highest precedence first: where two reviews
 * compete for the one column, the earlier one is kept.
 */
export const IMAGE_REVIEW_PRECEDENCE = [
  'csam',
  'minor',
  'poi',
  'appeal',
  'modRule',
  'tag',
  'remixSource',
  'newUser',
] as const;

export type ImageReviewType = (typeof IMAGE_REVIEW_PRECEDENCE)[number];

/** The review flag only the CSAM review clears: no unblock or other accept lifts an image under it. */
export const CSAM_REVIEW_FLAG = 'csam' satisfies ImageReviewType;

/** The reviews a grace block's record may put back: never 'csam', which the block keeps on the row, so
 *  one recorded with none left was dismissed. */
export const RESTORABLE_REVIEWS = IMAGE_REVIEW_PRECEDENCE.filter((review) => review !== 'csam');

/** What lifting a grace-blocked image (an unblock or an approved appeal, either of which settles its
 *  appeal) keeps from the grace block's record. */
export const REVIEWS_KEPT_WHEN_LIFTED = RESTORABLE_REVIEWS.filter((review) => review !== 'appeal');
