/**
 * Blocked images served to moderators from storage, for when the public CDN does not serve them, by
 * the main app's `/api/mod/retracted-media` and the moderator app's `/api/retracted-media`. Constants
 * only, so a client-reachable import never pulls in the SQL; the rules are in `retracted-media-tier`.
 */

/** The mod-activity name recorded for every response that carries bytes, ranges included. */
export const RETRACTED_SERVED_ACTIVITY = 'retractedMedia:view';

/** Per moderator, per minute. */
export const RETRACTED_MEDIA_RATE_LIMIT = 600;

/** The per-moderator request counter both apps' routes count in, before the cache-key prefix. */
export const retractedMediaRateKey = (moderatorId: number) =>
  `retracted-media:rate-limit:${moderatorId}`;

/** The eligibility read's statement timeout: a read that cannot finish refuses. */
export const RETRACTED_MEDIA_READ_TIMEOUT_MS = 2_000;

/** The largest object served; a larger one is refused whole, ranges included. */
export const RETRACTED_MEDIA_MAX_BYTES = 250 * 1024 * 1024;

/** How long one response may stream before it is cut off. */
export const RETRACTED_MEDIA_STREAM_MS = 5 * 60_000;
