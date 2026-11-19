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
