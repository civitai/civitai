export const MODEL_FLAGS_PATH = '/models/flags';
export const MODEL_FLAGS_APPEALS_PATH = '/models/flags/appeals';
/** Flags automation already applied: confirm or revert. */
export const MODEL_FLAGS_AUTO_PATH = '/models/flags/auto';
/** Leads nothing has been applied for yet (held detections, file matches): flag or dismiss. */
export const MODEL_FLAGS_NEEDS_REVIEW_PATH = '/models/flags/needs-review';

// Pages that no longer exist; kept so bookmarks redirect (`$lib/moved-pages`).
export const LEGACY_MINOR_HASH_PATH = '/models/minor-hash-matches';
export const LEGACY_FLAG_APPEALS_PATH = '/models/flag-appeals';
export const LEGACY_HELD_DETECTIONS_PATH = '/models/held-detections';
export const LEGACY_FLAGS_REVIEW_PATH = '/models/flags/review';
export const LEGACY_FLAGS_MATCHES_PATH = '/models/flags/matches';

/** The line under each tab's label; what the moderator is there to do. */
export const MODEL_FLAG_TAB_HINTS: Record<string, string> = {
  [MODEL_FLAGS_APPEALS_PATH]: 'owner is waiting',
  [MODEL_FLAGS_AUTO_PATH]: 'flag applied · confirm or revert',
  [MODEL_FLAGS_NEEDS_REVIEW_PATH]: 'not applied · flag or dismiss',
};
