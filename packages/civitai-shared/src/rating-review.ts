import {
  browsingLevels,
  getBrowsingLevelLabel,
  NsfwLevel,
  nsfwBrowsingLevelsFlag,
} from './browsing-levels';

export const RATING_REVIEW_ENTITY_TYPES = [
  'Article',
  'Model',
  'Post',
  'Bounty',
  'BountyEntry',
  'Challenge',
  'Crucible',
  'Collection',
  // A song is an `Image` row of type audio; its own value keeps a plain image from being disputable.
  'Song',
] as const;
export type RatingReviewEntityType = (typeof RATING_REVIEW_ENTITY_TYPES)[number];

/** Model meta key a system check writes beside the nsfw lock it adds; any other lock change clears it. */
export const SYSTEM_NSFW_LOCK_META_KEY = 'systemNsfwLock';

export function isRatingReviewEntityType(v: unknown): v is RatingReviewEntityType {
  return typeof v === 'string' && (RATING_REVIEW_ENTITY_TYPES as readonly string[]).includes(v);
}

export const ratingReviewEntityLabels: Record<RatingReviewEntityType, string> = {
  Article: 'Article',
  Model: 'Model',
  Post: 'Post',
  Bounty: 'Bounty',
  BountyEntry: 'Bounty entry',
  Challenge: 'Challenge',
  Crucible: 'Crucible',
  Collection: 'Collection',
  Song: 'Song',
};

// A Model's rating override is its `nsfw` flag, not a level, so it is represented as PG (off) / R (on).
export const modelRatingLevel = (nsfw: boolean): number => (nsfw ? NsfwLevel.R : NsfwLevel.PG);

// Any NSFW bit in a collection's bucket reads as R.
export const collectionRatingLevel = (nsfwLevel: number): number =>
  nsfwLevel & nsfwBrowsingLevelsFlag ? NsfwLevel.R : NsfwLevel.PG;

// A collection's nsfwLevel is a bucket (SFW or every NSFW bit), so it has no level finer than PG/R.
export function ratingReviewLevels(entityType: RatingReviewEntityType): number[] {
  return entityType === 'Model' || entityType === 'Collection'
    ? [NsfwLevel.PG, NsfwLevel.R]
    : [...browsingLevels];
}

// A challenge's or crucible's level is an allowed-entry mask; raising one runs guarded side effects
// (entry voids, content checks, refunds) that only the main app can, so a dispute may only lower it.
const lowerOnly = (entityType: RatingReviewEntityType) =>
  entityType === 'Challenge' || entityType === 'Crucible';

export function ratingReviewOwnerLevels(
  entityType: RatingReviewEntityType,
  currentLevel: number
): number[] {
  const levels = ratingReviewLevels(entityType);
  return lowerOnly(entityType) ? levels.filter((l) => l < currentLevel) : levels;
}

export function ratingReviewModeratorLevels(
  entityType: RatingReviewEntityType,
  currentLevel: number
): number[] {
  const levels = ratingReviewLevels(entityType);
  return lowerOnly(entityType) ? levels.filter((l) => l <= currentLevel) : levels;
}

export function ratingReviewLevelLabel(
  entityType: RatingReviewEntityType,
  level: number | null | undefined
): string {
  if ((entityType === 'Model' || entityType === 'Collection') && level)
    return level >= NsfwLevel.R ? 'NSFW' : 'SFW';
  return getBrowsingLevelLabel(level);
}

export function ratingReviewEntityPath(
  entityType: RatingReviewEntityType,
  entityId: number,
  parentId?: number | null
): string | null {
  switch (entityType) {
    case 'Article':
      return `/articles/${entityId}`;
    case 'Model':
      return `/models/${entityId}`;
    case 'Post':
      return `/posts/${entityId}`;
    case 'Bounty':
      return `/bounties/${entityId}`;
    case 'BountyEntry':
      return parentId ? `/bounties/${parentId}/entries/${entityId}` : null;
    case 'Challenge':
      return `/challenges/${entityId}`;
    case 'Crucible':
      return `/crucibles/${entityId}`;
    case 'Collection':
      return `/collections/${entityId}`;
    case 'Song':
      return `/images/${entityId}`;
  }
}

// The ingest cron's scan retry ceilings, by stored failure class; the main app's
// `image-scan-failure.ts` exports these as its own. Here because a song's rating dispute also
// reads them: past its ceiling a song's scan is never re-sent, so it can never be reviewed.
export const IMAGE_SCAN_TRANSIENT_RETRY_LIMIT = 30; // bounded, but well above the old 9-cap
export const IMAGE_SCAN_UNKNOWN_RETRY_LIMIT = 9; // historical flood-protection cap
// Give up on the first failure: markImageScanError already bumped retryCount to 1, so
// `retryCount < 1` is false on the next cron pass and the image is never re-queued.
export const IMAGE_SCAN_PERMANENT_RETRY_LIMIT = 1;
/** A `Rescan` image is re-sent only while its retryCount is below this. */
export const IMAGE_RESCAN_RETRY_LIMIT = 9;

/** Absolute retry ceiling for a stored failure class (defaults to the conservative cap). */
export function imageScanRetryLimit(failureClass?: string | null): number {
  switch (failureClass) {
    case 'transient':
      return IMAGE_SCAN_TRANSIENT_RETRY_LIMIT;
    case 'permanent':
      return IMAGE_SCAN_PERMANENT_RETRY_LIMIT;
    default:
      return IMAGE_SCAN_UNKNOWN_RETRY_LIMIT;
  }
}

/** A song's ingestion, with `scanJobs.retryCount` and the failure class of its last failed scan. */
export type SongScanState = {
  ingestion: string;
  retryCount: number | null;
  failureClass: string | null;
};

/** A removed song, a lost file, or a scan past its retry ceiling: its own scans will never review it. */
export function songNeverReviewable({
  ingestion,
  retryCount,
  failureClass,
}: SongScanState): boolean {
  const retries = retryCount ?? 0;
  switch (ingestion) {
    case 'Blocked':
    case 'NotFound':
      return true;
    case 'Error':
      return retries >= imageScanRetryLimit(failureClass);
    case 'Rescan':
      return retries >= IMAGE_RESCAN_RETRY_LIMIT;
    default:
      return false;
  }
}

// XGuard and Clavata rows share the `result` column with a different shape; `version` is what marks a
// text-scan row, the same test the scan floor applies (`result->>'version' IS NOT NULL`).
export function textScanNsfwReason(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { version?: unknown; labels?: { nsfw?: { reason?: unknown } } };
  if (r.version == null) return null;
  const reason = r.labels?.nsfw?.reason;
  return typeof reason === 'string' && reason.trim() ? reason : null;
}

// The hash of the text a completed scan read. A skipped or in-flight scan leaves the previous
// one in place, so it only moves once a new verdict lands.
export function textScanResultTextHash(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { version?: unknown; textHash?: unknown };
  if (r.version == null) return null;
  return typeof r.textHash === 'string' && r.textHash ? r.textHash : null;
}

export type RatingReviewNotificationDetails = {
  entityType: RatingReviewEntityType;
  entityId: number;
  title: string;
  url: string;
  previousLevel: string;
  appliedLevel: string;
  modComment: string | null;
};

export type RatingReviewNotification = {
  type: 'rating-review-approved' | 'rating-review-rejected';
  key: string;
  details: RatingReviewNotificationDetails;
};

export function buildRatingReviewNotification(input: {
  reviewId: number;
  approved: boolean;
  entityType: RatingReviewEntityType;
  entityId: number;
  parentId?: number | null;
  title: string;
  previousLevel: number;
  appliedLevel: number;
  modComment?: string | null;
}): RatingReviewNotification {
  const type = input.approved ? 'rating-review-approved' : 'rating-review-rejected';
  return {
    type,
    key: `${type}:${input.reviewId}`,
    details: {
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      url: ratingReviewEntityPath(input.entityType, input.entityId, input.parentId) ?? '/',
      previousLevel: ratingReviewLevelLabel(input.entityType, input.previousLevel),
      appliedLevel: ratingReviewLevelLabel(input.entityType, input.appliedLevel),
      modComment: input.modComment ?? null,
    },
  };
}
