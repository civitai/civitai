/**
 * Blocked images served to moderators from storage, for when the public CDN no longer serves them,
 * by the main app's `/api/mod/retracted-media`. In a shared package so a moderator-app route runs the
 * same rules. Constants only, so the feature-flag list can read the key without pulling in the SQL;
 * the rules are in `retracted-media-tier`.
 */

/** The flag the route reads; off, it answers 403. */
export const RETRACTED_MEDIA_FLIPT_KEY = 'mod-retracted-media';

/** The mod-activity name recorded for every response that carries bytes, ranges included. */
export const RETRACTED_SERVED_ACTIVITY = 'retractedMedia:view';

/** Per moderator, per minute. */
export const RETRACTED_MEDIA_RATE_LIMIT = 600;

/** The largest object served; a larger one is refused whole, ranges included. */
export const RETRACTED_MEDIA_MAX_BYTES = 250 * 1024 * 1024;

/** How long one response may stream before it is cut off. */
export const RETRACTED_MEDIA_STREAM_MS = 5 * 60_000;
