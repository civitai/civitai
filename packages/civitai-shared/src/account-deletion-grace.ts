import { NsfwLevel } from './browsing-levels';

/**
 * Account-deletion grace: the breadcrumbs a grace block writes on an image, and what a moderator's lift
 * does while the owner is deleted. The main app and the moderator app each write the SQL; both read
 * these values, so the rule cannot drift between them.
 */

/** The image's ingestion before the grace block, which an account restore puts back. */
export const GRACE_PRIOR_INGESTION_KEY = 'accountDeletionPriorIngestion';
/** The image's blockedFor before the grace block. */
export const GRACE_PRIOR_BLOCKED_FOR_KEY = 'accountDeletionPriorBlockedFor';
/** The image's needsReview before the grace block. */
export const GRACE_PRIOR_NEEDS_REVIEW_KEY = 'accountDeletionPriorNeedsReview';
/**
 * The image's nsfwLevel and rating lock before the grace block, which forces the level to Blocked. A
 * restore puts both back; a row without them (blocked before they were recorded, or lifted while the
 * owner was deleted) is re-rated instead.
 */
export const GRACE_PRIOR_NSFW_LEVEL_KEY = 'accountDeletionPriorNsfwLevel';
export const GRACE_PRIOR_NSFW_LOCKED_KEY = 'accountDeletionPriorNsfwLevelLocked';

/**
 * The recorded rating a moderator's re-rate of a grace-blocked image leaves: theirs, locked, so an account
 * restore puts back their rating rather than the one from before the deletion. Nothing for any other row.
 */
export function ratingRecordedUnderGrace(
  metadata: Record<string, unknown> | null | undefined,
  nsfwLevel: number
): Record<string, unknown> {
  if (!metadata || metadata[GRACE_PRIOR_INGESTION_KEY] == null) return {};
  return { [GRACE_PRIOR_NSFW_LEVEL_KEY]: nsfwLevel, [GRACE_PRIOR_NSFW_LOCKED_KEY]: true };
}

/** Every breadcrumb above. A write that strips them strips this list, so a new key is never missed. */
export const GRACE_PRIOR_KEYS = [
  GRACE_PRIOR_INGESTION_KEY,
  GRACE_PRIOR_BLOCKED_FOR_KEY,
  GRACE_PRIOR_NEEDS_REVIEW_KEY,
  GRACE_PRIOR_NSFW_LEVEL_KEY,
  GRACE_PRIOR_NSFW_LOCKED_KEY,
];

/**
 * A lift (an approved appeal, an accept, an unblock) while the owner is deleted: the row keeps a block, and
 * the breadcrumbs record the lifted state, so an account restore brings it back and a purge removes it.
 * A deleted owner's image is never served.
 */
export const LIFT_WHILE_OWNER_DELETED = {
  keeps: { ingestion: 'Blocked', blockedFor: 'moderated', nsfwLevel: NsfwLevel.Blocked },
  records: { ingestion: 'Scanned', blockedFor: null },
} as const;

/** The JobQueue row whose createdAt starts a blocked image's purge clock. */
export const BLOCKED_IMAGE_DELETE_QUEUE = {
  type: 'BlockedImageDelete',
  entityType: 'Image',
} as const;

/**
 * The ModActivity a lift kept blocked writes instead of 'review': not a takedown activity, so the
 * CDN sync and the purge do not read the lift as a moderator removal.
 */
export const LIFT_KEPT_ACTIVITY = 'reviewOwnerDeleted';
