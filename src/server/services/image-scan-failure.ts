/**
 * Reason-aware classification of image-scan failures.
 *
 * Image scans submit an orchestrator workflow (wdTagging / mediaRating / mediaHash);
 * on a non-success terminal event the webhook flips the image to `Error` and the
 * `ingest-images` cron re-queues it until it succeeds or hits a ceiling. Historically
 * that ceiling was a single flat 9-cap — which gives up on *transient infra churn*
 * (e.g. Submodel/Siglip container instability: "Failed to create container…", 5xx on
 * wdTagging) even though those succeed once the worker stabilizes.
 *
 * This module classifies a failure from its human `reason` string (captured off the
 * job-level orchestrator callback) plus the failing step, so the cron can keep
 * retrying transient failures under a higher — but still bounded — ceiling while
 * giving up almost immediately on genuinely unscannable media. The ceilings are the
 * hard backstop that stops any image re-flooding the scanner forever.
 */

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

// Retry ceilings by class. The cron ALWAYS increments `scanJobs.retryCount` on every
// failed attempt (see markImageScanError) — these are the absolute backstops applied
// against that ever-incrementing count.
export const IMAGE_SCAN_TRANSIENT_RETRY_LIMIT = 30; // bounded, but well above the old 9-cap
export const IMAGE_SCAN_UNKNOWN_RETRY_LIMIT = 9; // historical flood-protection cap
// Give up on the first failure: markImageScanError already bumped retryCount to 1, so
// `retryCount < 1` is false on the next cron pass and the image is never re-queued.
export const IMAGE_SCAN_PERMANENT_RETRY_LIMIT = 1;

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

/** Absolute retry ceiling for a stored failure class (defaults to the conservative cap). */
export function getImageScanRetryLimit(failureClass?: string | null): number {
  switch (failureClass) {
    case ImageScanFailureClass.Transient:
      return IMAGE_SCAN_TRANSIENT_RETRY_LIMIT;
    case ImageScanFailureClass.Permanent:
      return IMAGE_SCAN_PERMANENT_RETRY_LIMIT;
    default:
      return IMAGE_SCAN_UNKNOWN_RETRY_LIMIT;
  }
}
