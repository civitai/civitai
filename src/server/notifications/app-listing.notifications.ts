import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

/**
 * App Store Listings (W13) — owner-facing moderation notifications.
 *
 * The listing owner (an app developer) has no other signal today that a moderator
 * acted on their off-site listing. These four IMPERATIVE notification types are
 * emitted directly from the off-site listing/moderation services (via
 * `createNotification`) — NOT from a scheduled `prepareQuery` scan — so they carry
 * NO `prepareQuery`, only a `prepareMessage` (mirrors the auction / challenge
 * imperative notifications). Each carries the acting reason (where a mod supplied
 * one) + a link to the owner's submissions view.
 *
 * The `type` strings are free-form (the notifications app stores them as text — no
 * DB enum), so adding these needs NO notifications-DB migration (same as the
 * auction/challenge imperative types). Registered in `utils.notifications.ts`.
 *
 * DARK: the emitting procs are all behind the App Blocks author/mod flags, so no
 * owner receives one until the App Blocks segment widens.
 */

export type AppListingModerationNotificationDetails = {
  /** The public store slug (identity + link hint). */
  slug: string;
  /** The listing display name (best-effort — may be absent for a terse payload). */
  name?: string | null;
  /** The moderator's rationale, where one was supplied (delist/reset always; approve none). */
  reason?: string | null;
  /** The listing id (`apl_<ULID>`) for a future deep-link. */
  listingId?: string | null;
};

/** All four owner notifications point the owner at their submissions/history view. */
const OWNER_SUBMISSIONS_URL = '/apps/my-submissions';

function appLabel(details: AppListingModerationNotificationDetails): string {
  return details.name ? `"${details.name}"` : 'Your app';
}

/** Append ": <reason>" only when a non-empty reason is present. */
function withReason(base: string, reason?: string | null): string {
  const trimmed = reason?.trim();
  return trimmed ? `${base}: ${trimmed}` : `${base}.`;
}

export const appListingNotifications = createNotificationProcessor({
  'app-listing-approved': {
    displayName: 'App listing approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: `${appLabel(details)} was approved and is now live in the app store.`,
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
  'app-listing-rejected': {
    displayName: 'App listing not approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: withReason(`${appLabel(details)} was not approved`, details.reason),
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
  'app-listing-hidden': {
    displayName: 'App listing hidden',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: withReason(
          `${appLabel(details)} was hidden from the app store by a moderator`,
          details.reason
        ),
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
  'app-listing-reset-to-pending': {
    displayName: 'App listing needs re-review',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as AppListingModerationNotificationDetails;
      return {
        message: withReason(
          `${appLabel(details)} was sent back for another review by a moderator`,
          details.reason
        ),
        url: OWNER_SUBMISSIONS_URL,
      };
    },
  },
});
