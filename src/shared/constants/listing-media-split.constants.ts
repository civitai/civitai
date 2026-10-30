/** A moderator's go-live decision on a listing's media split (`~/shared/utils/listing-media-split`). */
export const LISTING_MEDIA_SPLIT_DECISIONS = ['split', 'rate-mature'] as const;
export type ListingMediaSplitDecision = (typeof LISTING_MEDIA_SPLIT_DECISIONS)[number];

/**
 * Why a civitai.red icon / cover override cannot be set: the environment does not have the slot
 * columns yet. The server refuses a write with it, and the author's editor shows it in place of
 * the picker, so the two say the same thing.
 */
export const RED_SLOTS_UNAVAILABLE_MESSAGE =
  'A civitai.red-only icon or cover is not available on this environment yet. The listing shows its own icon and cover on every host.';
