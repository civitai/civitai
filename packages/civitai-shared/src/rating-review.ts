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

// How the ingest cron classifies a failed image scan (the main app's `image-scan-failure.ts`
// exports these as its own; that module's header explains the classes).
export const ImageScanFailureClass = {
  /** Infra churn that recovers on its own (container-create, 5xx, timeout, expiry). Keep retrying. */
  Transient: 'transient',
  /** The media itself can't be downloaded/decoded — it will never scan. Stop almost immediately. */
  Permanent: 'permanent',
  /** Unclassifiable reason. Retry conservatively under the historical cap. */
  Unknown: 'unknown',
} as const;
export type ImageScanFailureClass =
  (typeof ImageScanFailureClass)[keyof typeof ImageScanFailureClass];

// Reason substrings that mark infra-transient failures. Matched case-insensitively.
const TRANSIENT_REASON_PATTERNS = [
  'failed to create container',
  'giving up after', // "…Giving up after 10 attempts"
  'does not indicate success: 5', // 5xx surfaced by a worker, e.g. "500 (Internal Server Error)"
  'internal server error',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'timed out',
  'timeout',
  'connection reset',
  'connection refused',
  'temporarily unavailable',
  // A flapping worker pool: a fresh re-submit mostly lands on a worker that serves the job.
  'no provider supports this job',
  'retracted support',
];

// Orchestrator middleware / step markers that are infra-transient regardless of message.
// Aspirational: the v2 job event doesn't expose `current_middleware` today, so in
// practice container failures classify via the reason text ("Failed to create
// container…") below. Kept so classification improves for free if middleware ever
// arrives (via the passed `middleware` or a failing step named after it).
const TRANSIENT_MIDDLEWARE_PATTERNS = ['preparemanagedcontainer', 'preparecontainer'];

// Reason substrings that mark a permanently-bad input (the media can't be fetched/decoded).
const PERMANENT_REASON_PATTERNS = [
  'download',
  'decode',
  'corrupt',
  'invalid image',
  'invalid media',
  'not a valid',
  // Not a bare 'too large' — that would also match our own oversized request body.
  'image is too large',
  'unsupported',
  'unscannable',
];

/**
 * Classify a scan failure. Transient checks run first so a 5xx *while downloading*
 * (which is recoverable) isn't mislabeled permanent by the `download` marker.
 * Robust to empty/unknown reasons — falls back to `Unknown` (conservative retry).
 */
export function classifyImageScanFailure(input: {
  reason?: string | null;
  failureType?: string | null;
  middleware?: string | null;
  failedSteps?: string[] | null;
}): ImageScanFailureClass {
  const { reason, failureType, middleware, failedSteps } = input;

  // Workflow expiry (the orchestrator's 10-min cap) is always a transient timeout:
  // the work never ran to completion, so a re-scan can still succeed.
  if (failureType === 'expired') return ImageScanFailureClass.Transient;

  const haystack = [reason, middleware, ...(failedSteps ?? [])]
    .filter((x): x is string => !!x)
    .join(' ')
    .toLowerCase();

  if (!haystack) return ImageScanFailureClass.Unknown;

  if (TRANSIENT_MIDDLEWARE_PATTERNS.some((p) => haystack.includes(p)))
    return ImageScanFailureClass.Transient;
  if (TRANSIENT_REASON_PATTERNS.some((p) => haystack.includes(p)))
    return ImageScanFailureClass.Transient;
  if (PERMANENT_REASON_PATTERNS.some((p) => haystack.includes(p)))
    return ImageScanFailureClass.Permanent;

  return ImageScanFailureClass.Unknown;
}

/** The class the ingest cron retries a row under: a row stamped Unknown (or not at all) before its
 *  reason was recognised retries as what its reason reads as now. */
export function effectiveScanFailureClass(
  failureClass: string | null | undefined,
  reason: string | null | undefined
): string | null {
  if (reason && (!failureClass || failureClass === ImageScanFailureClass.Unknown))
    return classifyImageScanFailure({ reason });
  return failureClass ?? null;
}

// The ingest cron's scan retry ceilings, by stored failure class; the main app's
// `image-scan-failure.ts` exports these as its own. Here because a song's rating dispute also
// reads them: past its ceiling a song's scan is never re-sent, so it can never be reviewed.
export const IMAGE_SCAN_TRANSIENT_RETRY_LIMIT = 30;
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

/** A song's ingestion, with `scanJobs.retryCount` and the stored class and reason of its last failed
 *  scan, read as the ingest cron reads them. */
export type SongScanState = {
  ingestion: string;
  retryCount: number | null;
  failureClass: string | null;
  failureReason: string | null;
};

/** A song's `SongScanState` from its `scanJobs`, as the ingest cron reads them: the current error's
 *  class and reason, else the last failure's. */
export function songScanStateOf(ingestion: string, scanJobs: unknown): SongScanState {
  const jobs = (scanJobs ?? {}) as {
    retryCount?: unknown;
    error?: { failureClass?: unknown; reason?: unknown };
    lastFailure?: { failureClass?: unknown; reason?: unknown };
  };
  const failure = jobs.error ?? jobs.lastFailure;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    ingestion,
    retryCount: typeof jobs.retryCount === 'number' ? jobs.retryCount : null,
    failureClass: text(failure?.failureClass),
    failureReason: text(failure?.reason),
  };
}

/** Whether the owner may dispute a song's rating: only once its own scans reviewed it, the rating a
 *  moderator may rule on. The main app's song menu and its dispute writer both ask this. */
export function songDisputable(ingestion: string): boolean {
  return ingestion === 'Scanned';
}

/** A removed song, a lost file, or a scan past its retry ceiling: its own scans will never review it. */
export function songNeverReviewable({
  ingestion,
  retryCount,
  failureClass,
  failureReason,
}: SongScanState): boolean {
  const retries = retryCount ?? 0;
  switch (ingestion) {
    case 'Blocked':
    case 'NotFound':
      return true;
    case 'Error':
      return retries >= imageScanRetryLimit(effectiveScanFailureClass(failureClass, failureReason));
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
