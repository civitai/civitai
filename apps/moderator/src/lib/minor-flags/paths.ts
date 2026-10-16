export const MODEL_FLAGS_PATH = '/models/flags';
export const MODEL_FLAGS_APPEALS_PATH = '/models/flags/appeals';
export const MODEL_FLAGS_REVIEW_PATH = '/models/flags/review';
export const MODEL_FLAGS_MATCHES_PATH = '/models/flags/matches';

// Pages that no longer exist; kept so bookmarks redirect (`$lib/moved-pages`).
export const LEGACY_MINOR_HASH_PATH = '/models/minor-hash-matches';
export const LEGACY_FLAG_APPEALS_PATH = '/models/flag-appeals';
export const LEGACY_HELD_DETECTIONS_PATH = '/models/held-detections';

/** The line under each tab's label; what the moderator is there to do. */
export const MODEL_FLAG_TAB_HINTS: Record<string, string> = {
  [MODEL_FLAGS_APPEALS_PATH]: 'owner is waiting',
  [MODEL_FLAGS_REVIEW_PATH]: 'confirm or revert',
  [MODEL_FLAGS_MATCHES_PATH]: 'flag or dismiss',
};
