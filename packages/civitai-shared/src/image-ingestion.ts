/** A scan with no verdict after this long has stalled. The stuck-scan alert and the moderator page
 *  that triages it must agree. */
export const STUCK_PENDING_MINUTES = 15;

/** `blockedFor` values only a moderator or the image's own re-verification may lift, lower-cased. */
const MODERATION_BLOCK_REASONS = new Set(['csam', 'moderated', 'tos', 'ainotverified']);

export const MODERATION_BLOCK_REFUSAL =
  'This image has a moderation block; resolve it from block review.';
export const INACTIVE_OWNER_REFUSAL =
  "This image's owner account is banned or deleted; it can't be published from here.";

/**
 * Why resolving an ingestion error (publishing the image at a moderator-chosen rating) must not run
 * on this image, or null when it may. Any other `blockedFor` was set by the scan, and the resolve
 * clears it.
 */
export function ingestionResolveRefusal(image: {
  blockedFor: string | null;
  needsReview: string | null;
  ownerBannedAt: Date | null;
  ownerDeletedAt: Date | null;
}): string | null {
  if (
    image.needsReview === 'csam' ||
    (image.blockedFor != null &&
      MODERATION_BLOCK_REASONS.has(image.blockedFor.trim().toLowerCase()))
  )
    return MODERATION_BLOCK_REFUSAL;
  if (image.ownerBannedAt != null || image.ownerDeletedAt != null) return INACTIVE_OWNER_REFUSAL;
  return null;
}
