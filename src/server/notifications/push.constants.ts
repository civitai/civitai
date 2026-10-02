/**
 * Notification types that get a `UserPushSetting` row materialized when a user grants push
 * permission for the first time. Materialized, not implied: absence of a row must always mean
 * "no push", so this list is only ever read at grant time. Editing it later reaches NEW
 * subscribers only — existing subscribers keep the rows they were granted with.
 *
 * Only toggleable types belong here: a non-toggleable type (e.g. the strike family) renders no
 * control, so a default push row for it could never be turned off short of revoking the browser
 * permission entirely.
 */
export const DEFAULT_PUSH_TYPES = [
  'new-mention',
  'new-comment-reply',
  'new-comment-response',
  'tip-received',
];
