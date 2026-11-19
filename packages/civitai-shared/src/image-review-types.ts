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

/** The reviews a grace block's record may put back: never 'csam', which the block keeps on the row, so
 *  one recorded with none left was dismissed. */
export const RESTORABLE_REVIEWS = IMAGE_REVIEW_PRECEDENCE.filter((review) => review !== 'csam');

/** What an approved appeal keeps from a grace block's record: a review it does not itself settle. */
export const REVIEWS_KEPT_ON_APPEAL_APPROVAL = RESTORABLE_REVIEWS.filter(
  (review) => review !== 'appeal'
);
