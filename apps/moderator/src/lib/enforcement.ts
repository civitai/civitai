/**
 * Closed lists shared by enforcement pages AND the services behind them.
 *
 * In `$lib`, not `$lib/server`: pickers render these, and a component importing a server module drags
 * the database client into the client bundle. The legal direction is server → here; each list had
 * drifted into three copies (two client, one server) before this file existed.
 */

/** Mirrors the main app's `BanReasonCode`, which `/api/mod/ban-user` parses strictly — a code added
 *  there and not here is missing from the dropdown; one added only here 500s the ban. */
export const BAN_REASONS = [
  'SexualMinor',
  'SexualMinorGenerator',
  'SexualMinorTraining',
  'SexualPOI',
  'Bestiality',
  'Scat',
  'Nudify',
  'Harassment',
  'SpamBot',
  'LeaderboardCheating',
  'BuzzCheating',
  'RRDViolation',
  'Other',
] as const;

export type BanReasonCode = (typeof BAN_REASONS)[number];

/**
 * Reasons where leaving the content up is never the intent, so every removal toggle is pre-ticked.
 * The moderator can still untick, and each ban form warns what will go before it is confirmed.
 *
 * Shared by the single- and bulk-ban forms. The main app's `UserBanModal` has its own list because it
 * cannot import across the app boundary, and it is deliberately NOT identical: it also pre-ticks media
 * for `SexualMinor`, which this list leaves out because `toggleBan` already defaults that server-side.
 * A new code that should take content down belongs in both.
 */
export const BAN_REASONS_REMOVING_CONTENT: BanReasonCode[] = ['SpamBot'];

/** Free-text profile fields a moderator can clear, as `[column, label]`. */
export const PROFILE_FIELDS = [
  ['bio', 'Bio'],
  ['message', 'Profile message'],
  ['location', 'Location'],
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number][0];
export const PROFILE_FIELD_KEYS = PROFILE_FIELDS.map(([key]) => key) as ProfileField[];
