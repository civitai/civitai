/**
 * App Blocks batch private upload (`OPEN_MEDIA_UPLOAD_BATCH`): the limits the page host and the
 * server agree on. The SDK's mock host (`@civitai/blocks-react`, `mediaUploadBytes.ts`) copies the
 * per-batch ones and the error strings, so change both.
 */

/** Files one batch may hold: at most a whole day's quota, so no batch is refused for size alone. */
export const MEDIA_UPLOAD_BATCH_MAX_ITEMS = 1200;

/**
 * Files one viewer may upload through batches per UTC day, across all apps. The same figure as the
 * Training Studio's daily auto-label cap, so a day's batch uploads can all be auto-labelled. Each is
 * its own policy; changing one does not change the other.
 */
export const MEDIA_UPLOAD_BATCH_DAILY_ITEMS = 1200;

/** Raw bytes one viewer may upload through batches per UTC day, across all apps: 10 GiB. Adjustable. */
export const MEDIA_UPLOAD_BATCH_DAILY_BYTES = 10 * 1024 ** 3;

/** Raw bytes one batch may hold: a whole day's byte quota. */
export const MEDIA_UPLOAD_BATCH_MAX_BYTES = MEDIA_UPLOAD_BATCH_DAILY_BYTES;
/** The refusal for a batch over `MEDIA_UPLOAD_BATCH_MAX_BYTES`. The SDK's mock host spells the same. */
export const MEDIA_UPLOAD_BATCH_TOO_LARGE_ERROR = 'the batch exceeds the 10 GB limit';

/**
 * How long a batch's files are kept at least, from when the batch started: the orchestrator's default
 * consumer-blob retention (30 days, renewed when a blob is refreshed). Nothing here pins it; this is
 * the `expires_at` the audit row records, not a promise of deletion.
 */
export const MEDIA_UPLOAD_BATCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How many of a batch's files the page host uploads at once. */
export const MEDIA_UPLOAD_BATCH_CONCURRENCY = 3;

/** The refusal when the flag is off for the viewer. */
export const MEDIA_UPLOAD_BATCH_DISABLED_ERROR = 'batch media upload is not available';
/** The refusal before the audit table exists in this environment. */
export const MEDIA_UPLOAD_BATCH_UNAVAILABLE_ERROR =
  'batch media upload is not available yet, please try again later';

/** The refusal past the daily quota. Written for the viewer; the host relays it. */
export function mediaUploadBatchQuotaError(): string {
  const files = MEDIA_UPLOAD_BATCH_DAILY_ITEMS.toLocaleString('en-US');
  const gb = MEDIA_UPLOAD_BATCH_DAILY_BYTES / 1024 ** 3;
  return `You've reached today's batch upload limit (${files} files or ${gb} GB). It resets at midnight UTC.`;
}
