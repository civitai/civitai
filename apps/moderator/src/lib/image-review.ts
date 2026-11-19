import type { PromptHighlightCategory } from '@civitai/mod-utils/prompt-audit';
import type { ImageReviewType as AnyImageReviewType } from '@civitai/shared/image-review-types';

/** The review queues; appeals have their own. */
export type ImageReviewType = Exclude<AnyImageReviewType, 'appeal'>;

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

const IMAGE_REVIEW_REASONS: Record<AnyImageReviewType, string> = {
  minor: 'The scan, the prompt, an attached resource or a collection AI review suggested a minor.',
  poi: 'The scan, the prompt, an attached resource, or a bounty it belongs to or was entered into suggested a real person.',
  tag: 'An applied tag sends images to review.',
  newUser: 'A mature image from a new account.',
  modRule: 'A moderation rule held it for review.',
  remixSource:
    'A generation request that named this image as its remix source was refused or soft-flagged, and this image’s own prompt then tripped the prompt audit (a soft-flag word is enough) or external moderation.',
  csam: 'Held for child-safety review.',
  appeal: 'The uploader appealed a removal.',
};

export function reviewReasonText(needsReview: string): string {
  return Object.hasOwn(IMAGE_REVIEW_REASONS, needsReview)
    ? IMAGE_REVIEW_REASONS[needsReview as keyof typeof IMAGE_REVIEW_REASONS]
    : `Flagged for review: ${needsReview}.`;
}

/** Outside review, `nsfw` is left out: it matches most mature prompts and would read as a reason. */
export function reviewHighlightCategories(
  needsReview: string | null
): PromptHighlightCategory[] | undefined {
  if (needsReview === 'minor') return ['minor', 'young', 'age'];
  if (needsReview) return undefined;
  return ['minor', 'young', 'age', 'poi', 'blocked'];
}

/** The one review flag a block keeps: only its own queue, a filed report or an explicit unblock
 *  clears it. */
export const FLAG_KEPT_THROUGH_BLOCK = 'csam' satisfies ImageReviewType;

/**
 * Removed, with only that flag left to rule on. Accepting would put the image back live and
 * removing it again would notify the uploader a second time, so the one verdict left is to dismiss
 * it from the queue.
 */
export function isFlagOnlyRemaining(image: { needsReview: string | null; ingestion: string }) {
  return image.needsReview === FLAG_KEPT_THROUGH_BLOCK && image.ingestion === 'Blocked';
}
