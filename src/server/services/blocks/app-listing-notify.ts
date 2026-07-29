import type { AppListingModerationNotificationDetails } from '~/server/notifications/app-listing.notifications';

/**
 * App Store Listings (W13) — owner-notification emit helper.
 *
 * A thin, best-effort wrapper the off-site listing/moderation services call AFTER
 * their transaction commits to notify the listing owner of a mod action. Kept in a
 * DEDICATED module whose ONLY static import is a TYPE (erased at compile), and which
 * DYNAMICALLY imports `createNotification` + `NotificationCategory` inside the async
 * body — so importing this helper adds ZERO runtime graph to a caller (mirrors the
 * services' own dynamic-import discipline for heavy deps). This keeps the service
 * unit tests (which mock only `dbRead`/`dbWrite`) from pulling the notifications
 * client; a test that asserts emission mocks `~/server/services/notification.service`.
 *
 * `createNotification` is itself best-effort (it swallows client errors + logs), and
 * these are emitted post-commit, so a notification failure never affects the action.
 */

export type AppListingOwnerNotificationType =
  | 'app-listing-approved'
  | 'app-listing-rejected'
  | 'app-listing-hidden'
  | 'app-listing-reset-to-pending';

export async function notifyAppListingOwner(opts: {
  type: AppListingOwnerNotificationType;
  userId: number;
  /** Idempotency key — dedups repeat emissions of the same event to the same user. */
  key: string;
  details: AppListingModerationNotificationDetails;
}): Promise<void> {
  const [{ createNotification }, { NotificationCategory }] = await Promise.all([
    import('~/server/services/notification.service'),
    import('~/server/common/enums'),
  ]);
  await createNotification({
    userId: opts.userId,
    category: NotificationCategory.System,
    type: opts.type,
    key: opts.key,
    details: opts.details,
  });
}
