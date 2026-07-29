import type { AppBlockModerationNotificationDetails } from '~/server/notifications/app-block.notifications';

/**
 * App Blocks (on-site) — submitter-notification emit helper.
 *
 * A thin, best-effort wrapper `approveRequest` / `rejectRequest` call AFTER their
 * state transition commits, to notify the SUBMITTING developer of the moderator
 * decision. Kept in a DEDICATED module whose ONLY static import is a TYPE (erased at
 * compile), and which DYNAMICALLY imports `createNotification` +
 * `NotificationCategory` inside the async body — so importing this helper adds ZERO
 * runtime graph to the caller (mirrors the off-site `app-listing-notify` helper and
 * the publish-request service's own dynamic-import discipline for heavy deps). This
 * keeps the service's unit tests from pulling the notifications client; a test that
 * asserts emission mocks THIS module (`~/server/services/blocks/app-block-notify`),
 * and a test that asserts the swallow mocks `~/server/services/notification.service`.
 *
 * `createNotification` is itself best-effort (it swallows client errors + logs), and
 * this is emitted post-commit, so a notification failure never affects the decision.
 * The CALLERS additionally wrap this call in a try/catch — so even a defect that made
 * this helper throw can never fail or roll back a moderator approve/reject.
 */

export type AppBlockSubmitterNotificationType = 'app-block-approved' | 'app-block-rejected';

export async function notifyAppBlockSubmitter(opts: {
  type: AppBlockSubmitterNotificationType;
  userId: number;
  /** Idempotency key — dedups repeat emissions of the same event to the same user. */
  key: string;
  details: AppBlockModerationNotificationDetails;
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
