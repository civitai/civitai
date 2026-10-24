import type { ServiceDealStatus } from '~/shared/utils/prisma/enums';

const HOUR = 3_600_000;

/** A request the seller has not answered by then expires, and the hold returns to the buyer. */
export const SERVICE_DEAL_ACCEPT_WINDOW_MS = 48 * HOUR;
/** How long past the due date before the buyer may cancel without the seller's agreement. */
export const SERVICE_DEAL_LATE_CANCEL_AFTER_MS = 24 * HOUR;
/** Unanswered cancellation requests are granted after this. */
export const SERVICE_DEAL_CANCELLATION_RESPONSE_MS = 48 * HOUR;
/** A delivery the buyer neither accepts nor sends back completes on its own after this. */
export const SERVICE_DEAL_AUTO_COMPLETE_MS = 72 * HOUR;
/** Between completion and payout, so a buyer can report final files that are missing or broken. */
export const SERVICE_DEAL_DISPUTE_WINDOW_MS = 48 * HOUR;

/**
 * When an unconfirmed hold is looked up. Longer than the Buzz call timeout, so a write that was
 * still in flight when the request gave up has landed (or failed) by then.
 */
export const SERVICE_DEAL_HOLD_RECONCILE_AFTER_MS = 10 * 60_000;
/**
 * How long a closed deal with an unconfirmed hold keeps being looked up, so a charge that lands
 * after the deal was cancelled is still found and returned.
 */
export const SERVICE_DEAL_HOLD_RECONCILE_LOOKBACK_MS = 7 * 24 * HOUR;

export const SERVICE_DEAL_OPEN_STATUSES = [
  'Requested',
  'Accepted',
  'Delivered',
  'InRevision',
  'CancellationRequested',
  'Disputed',
] as const satisfies readonly ServiceDealStatus[];

/** Closed with the Buzz going back to the buyer. */
export const SERVICE_DEAL_REFUND_STATUSES = [
  'Declined',
  'Expired',
  'Cancelled',
] as const satisfies readonly ServiceDealStatus[];

export type ServiceDealLegName = 'hold' | 'release' | 'fee' | 'refund';

/**
 * The Buzz external id of one leg. Derived from the deal and never time-based, so a retried leg
 * presents the same id and the Buzz service's dedupe is a real second line.
 */
export const serviceDealTransactionId = (dealId: number, leg: ServiceDealLegName) =>
  `creator-service-${dealId}-${leg}`;

/**
 * Delivery files. Previews are deliberately worth less than the product: capped in size, and the
 * buyer only ever sees a small watermarked derivative, never the seller's original.
 */
export const SERVICE_PREVIEW_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
export const SERVICE_PREVIEW_MAX_SIDE = 512;
/** The hidden copy that is scanned. Bigger than the published preview, unmarked, and deleted after. */
export const SERVICE_PREVIEW_SCAN_SIDE = 1024;
export const SERVICE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** An animated preview costs a CPU-second per few frames to mark, so it has its own, tighter, caps. */
export const SERVICE_PREVIEW_ANIMATED_MAX_BYTES = 20 * 1024 * 1024;
export const SERVICE_PREVIEW_ANIMATED_MAX_FRAMES = 60;
/** Previews a seller may upload per round, by the deal's preview kind. */
export const SERVICE_PREVIEW_MAX_FILES = {
  Image: 1,
  Video: 1,
  SampleOutputs: 12,
  None: 0,
} as const;

export const SERVICE_FINAL_MAX_FILES = 10;
/** Single-request upload and a 32-bit `size` column; a larger file needs multipart and a wider column. */
export const SERVICE_FINAL_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;
/** A presigned download is only valid long enough to start it. */
export const SERVICE_FILE_DOWNLOAD_EXPIRY_SECONDS = 5 * 60;
/** A preview stuck in Processing longer than this is picked up again. */
export const SERVICE_PREVIEW_PROCESSING_STALE_MS = 10 * 60_000;
/** A preview still not Ready this long after its upload is failed, so a delivery never hangs on it. */
export const SERVICE_PREVIEW_GIVE_UP_MS = 6 * HOUR;

/**
 * What a seller may deliver as a Final. Everything else is refused up front: a file type we cannot
 * inspect is not delivered, and video is refused outright until it can be moderated. Archives are limited to .zip, the one format the unpack step reads;
 * the rest (rar, 7z, tar and its compressions) cannot be enumerated here, so they are refused.
 */
export const SERVICE_FINAL_EXTENSIONS = [
  'zip',
  'safetensors',
  'ckpt',
  'pt',
  'pth',
  'gguf',
  'onnx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'mp3',
  'wav',
  'flac',
  'ogg',
  'pdf',
  'txt',
  'md',
  'json',
  'yaml',
  'yml',
  'csv',
] as const;
/**
 * The highest scan rating a preview may carry (PG-13). Services are SFW-only in v1; a preview above
 * this fails, and so does one the scan left unrated. Relaxing it is this one number.
 */
export const SERVICE_PREVIEW_MAX_NSFW_LEVEL = 2;

/**
 * The structured reasons a party may give when leaving a deal, one list per action. A muted party
 * gives only these: their free text is dropped, and a missing code becomes `other`.
 */
export const SERVICE_DEAL_DECLINE_REASON_CODES = [
  'too_busy',
  'out_of_scope',
  'price_or_terms',
  'other',
] as const;
export const SERVICE_DEAL_CANCELLATION_REASON_CODES = [
  'not_delivered',
  'quality',
  'changed_mind',
  'buyer_unresponsive',
  'cannot_complete',
  'other',
] as const;
export const SERVICE_DEAL_DISPUTE_REASON_CODES = [
  'files_missing_or_broken',
  'not_as_previewed',
  'other',
] as const;

export type ServiceDealDeclineReasonCode = (typeof SERVICE_DEAL_DECLINE_REASON_CODES)[number];
export type ServiceDealCancellationReasonCode =
  (typeof SERVICE_DEAL_CANCELLATION_REASON_CODES)[number];
export type ServiceDealDisputeReasonCode = (typeof SERVICE_DEAL_DISPUTE_REASON_CODES)[number];
export type ServiceDealReasonCode =
  | ServiceDealDeclineReasonCode
  | ServiceDealCancellationReasonCode
  | ServiceDealDisputeReasonCode;

/**
 * What a zip Final may hold. Every limit is checked against the bytes actually read, never only
 * against the sizes the archive declares about itself.
 */
export const SERVICE_ZIP_MAX_ENTRIES = 500;
export const SERVICE_ZIP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const SERVICE_ZIP_MAX_ENTRY_BYTES = 100 * 1024 * 1024;
export const SERVICE_ZIP_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const SERVICE_ZIP_MAX_RATIO = 100;
/** Entries are inflated one at a time; a ratio is only meaningful above this many bytes. */
export const SERVICE_ZIP_RATIO_FLOOR_BYTES = 1024 * 1024;
/** Image extensions inside a final. Anything else is judged by content, not by its name. */
export const SERVICE_ZIP_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;
/** Weights files. Refused inside a zip (deliver each as its own Final); a top-level one is not content-sniffed. */
export const SERVICE_ZIP_MODEL_EXTENSIONS = [
  'safetensors',
  'ckpt',
  'pt',
  'pth',
  'gguf',
  'bin',
  'onnx',
] as const;
export const SERVICE_ZIP_ARCHIVE_EXTENSIONS = [
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'zst',
  'lz',
  'lzma',
  'cab',
  'iso',
  'jar',
] as const;
export const SERVICE_ZIP_VIDEO_EXTENSIONS = [
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  'm4v',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'ogv',
  '3gp',
] as const;
/** A file being unpacked that has not finished in this long is taken up again by the next run. */
export const SERVICE_UNPACK_STALE_MS = 60 * 60_000;
/** After a failure that is not the file's fault, the file is tried again this long later; others go first. */
export const SERVICE_UNPACK_RETRY_MS = 5 * 60_000;
/** An image still Pending this long after its row was created is failed, so a round never hangs. */
export const SERVICE_FINAL_SCAN_GIVE_UP_MS = 6 * HOUR;
/** A Final's malware scan is submitted at most this many times before the Final is failed. */
export const SERVICE_FINAL_SCAN_MAX_ATTEMPTS = 5;
/** A malware scan that could not run is submitted again no sooner than this. */
export const SERVICE_FINAL_SCAN_RETRY_MS = 10 * 60_000;
/** A malware scan workflow with no verdict this long after submission is abandoned and resubmitted. */
export const SERVICE_FINAL_SCAN_STALE_MS = 2 * HOUR;

/**
 * Why the system sent a deal to the moderators rather than paying it out. Moderation detail about
 * the other party or the files, so the parties never see it (see `dealVisibleReason`).
 */
export const SERVICE_DEAL_HOLD_REASONS = {
  sellerUnavailable: 'seller_unavailable',
  finalScanFailed: 'final_scan_failed',
  finalAboveRating: 'final_above_rating',
} as const;

/**
 * The highest rating a service may carry and still be safe for work (PG-13). A service at or below it
 * is open to everyone everywhere; one above it is mature, and only requested where mature content is
 * served, by a buyer whose own browsing level includes it.
 */
export const SERVICE_SFW_MAX_NSFW_LEVEL = 2;
export const isMatureServiceLevel = (maxNsfwLevel: number) =>
  maxNsfwLevel > SERVICE_SFW_MAX_NSFW_LEVEL;

/**
 * Whether a buyer may request a service rated `maxNsfwLevel`: always for a SFW one; for a mature one
 * only where the domain serves that level and the buyer has opted into it. `requestServiceDeal`
 * repeats this rule in its INSERT.
 */
export const serviceRequestAllowed = ({
  maxNsfwLevel,
  servableLevels,
  consentLevels,
}: {
  maxNsfwLevel: number;
  servableLevels: number;
  consentLevels: number;
}) =>
  !isMatureServiceLevel(maxNsfwLevel) ||
  ((maxNsfwLevel & servableLevels) !== 0 && (maxNsfwLevel & consentLevels) !== 0);
