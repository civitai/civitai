/** A moderator's go-live decision on a listing's media split (`~/shared/utils/listing-media-split`). */
export const LISTING_MEDIA_SPLIT_DECISIONS = ['split', 'rate-mature'] as const;
export type ListingMediaSplitDecision = (typeof LISTING_MEDIA_SPLIT_DECISIONS)[number];
