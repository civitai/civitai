export type ImageReviewType =
  | 'minor'
  | 'poi'
  | 'tag'
  | 'newUser'
  | 'modRule'
  | 'remixSource'
  | 'csam';

export const IMAGE_REVIEW_SLUGS = [
  'minor',
  'poi',
  'tag',
  'newUser',
  'modRule',
  'remixSource',
] as const satisfies readonly ImageReviewType[];

export type ImageReviewSlug = (typeof IMAGE_REVIEW_SLUGS)[number];

export const IMAGE_VIEW_SLUGS = [...IMAGE_REVIEW_SLUGS, 'csam', 'reported', 'appeals'] as const;
export type ImageViewSlug = (typeof IMAGE_VIEW_SLUGS)[number];

/** The one review flag a block keeps: only its own queue, a filed report or an explicit unblock
 *  clears it. */
export const FLAG_KEPT_THROUGH_BLOCK = 'csam' satisfies ImageReviewType;

/**
 * Removed, with only that flag left to rule on. Accepting would put the image back live and
 * removing it again would notify the uploader a second time, so the one verdict left is to dismiss
 * the flag.
 */
export function isFlagOnlyRemaining(image: { needsReview: string | null; ingestion: string }) {
  return image.needsReview === FLAG_KEPT_THROUGH_BLOCK && image.ingestion === 'Blocked';
}
