/**
 * The weekly email of notifications a user has not seen. It is not a notification type (nothing in
 * the bell, no processor): it is an email-only setting that shares the per-type email opt-out table,
 * so its one-click unsubscribe and its settings switch both write a `UserEmailNotificationOptOut`
 * row for this type, and no row means the digest is on.
 */
export const MISSED_DIGEST_EMAIL_TYPE = 'missed-notification-digest';
export const MISSED_DIGEST_DISPLAY_NAME = 'Weekly email of notifications you missed';
