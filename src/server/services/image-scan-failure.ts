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

import { ImageScanFailureClass, imageScanRetryLimit } from '@civitai/shared/rating-review';

// Retry ceilings by class. The cron ALWAYS increments `scanJobs.retryCount` on every
// failed attempt (see markImageScanError; a 429 is not one) — these are the absolute
// backstops applied against that ever-incrementing count. The classes, the classifier and the
// ceilings are defined in @civitai/shared, which a song's rating dispute in both apps also reads.
export {
  classifyImageScanFailure,
  effectiveScanFailureClass,
  ImageScanFailureClass,
  IMAGE_RESCAN_RETRY_LIMIT,
  IMAGE_SCAN_PERMANENT_RETRY_LIMIT,
  IMAGE_SCAN_TRANSIENT_RETRY_LIMIT,
  IMAGE_SCAN_UNKNOWN_RETRY_LIMIT,
} from '@civitai/shared/rating-review';

// Minutes after a failed submit before the cron re-sends it. Transient failures usually clear
// on a fresh submit, so they wait less.
export const IMAGE_SCAN_TRANSIENT_RETRY_DELAY_MINUTES = 15;
export const IMAGE_SCAN_ERROR_RETRY_DELAY_MINUTES = 60;

/** Minutes an `Error` image of this failure class waits before its next retry. */
export function getImageScanRetryDelayMinutes(failureClass?: string | null): number {
  return failureClass === ImageScanFailureClass.Transient
    ? IMAGE_SCAN_TRANSIENT_RETRY_DELAY_MINUTES
    : IMAGE_SCAN_ERROR_RETRY_DELAY_MINUTES;
}

/** Absolute retry ceiling for a stored failure class (defaults to the conservative cap). */
export const getImageScanRetryLimit = imageScanRetryLimit;
