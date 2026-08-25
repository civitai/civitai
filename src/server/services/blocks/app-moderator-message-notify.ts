import type { AppModeratorMessageNotificationDetails } from '~/server/notifications/app-moderator-message.notifications';

/**
 * App Store Listings — moderator-message emit helper.
 *
 * The fourth member of the family (`app-block-notify`, `app-listing-notify`,
 * `app-collaborator-notify`) and built to the same discipline: the ONLY static import
 * is a TYPE (erased at compile), and `createNotification` + `NotificationCategory` are
 * imported DYNAMICALLY inside the async body — so importing this helper adds ZERO
 * runtime graph to a caller, and the service's unit tests never pull the notifications
 * client. A test that asserts emission mocks THIS module; a test that asserts the
 * swallow mocks `~/server/services/notification.service`.
 *
 * 🔴 MULTI-RECIPIENT IN ONE CALL, and that is the substrate's design rather than an
 * optimisation. `PendingNotification.key` is UNIQUE and a repeat emit with the same key
 * MERGES the new recipients into the existing row (`apps/notifications`'s
 * `create.ts`). So N separate calls sharing one key produce one notification with N
 * users anyway — passing `userIds` just says so up front and pays one round trip. It
 * also means a partial failure cannot deliver to the owner but not the editors.
 *
 * `createNotification` is itself best-effort (it swallows client errors + logs), and
 * this is emitted AFTER the audit event commits, so a notifications outage costs the
 * delivery, never the record that the moderator sent it.
 */

export async function notifyAppModeratorMessage(opts: {
  /** Every recipient of this one message. Must be non-empty. */
  userIds: number[];
  /** Idempotency key — dedups repeat emissions of the same event. */
  key: string;
  details: AppModeratorMessageNotificationDetails;
}): Promise<void> {
  // A zero-recipient emit would create a PendingNotification nobody can ever receive
  // and would burn the key, so a genuine later delivery under the same key would be
  // merged into the dead row instead of being sent. Refuse it at the boundary.
  if (opts.userIds.length === 0) return;
  const [{ createNotification }, { NotificationCategory }] = await Promise.all([
    import('~/server/services/notification.service'),
    import('~/server/common/enums'),
  ]);
  await createNotification({
    userIds: opts.userIds,
    category: NotificationCategory.System,
    type: 'app-moderator-message',
    key: opts.key,
    details: opts.details,
  });
}
