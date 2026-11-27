import type { AppReviewReplyNotificationDetails } from '~/server/notifications/app-review-thread.notifications';

/**
 * Review-thread reply emit helper, built like `app-listing-notify` / `app-moderator-message-notify`:
 * the only static import is a TYPE, and `createNotification` + `NotificationCategory` are imported
 * dynamically inside the body, so importing this adds no runtime graph to a caller.
 *
 * `createNotification` is itself best-effort (it swallows client errors and logs). The caller
 * emits after the message is stored and catches anything thrown here too, so a notification
 * failure never fails the post.
 */

export type AppReviewReplyNotificationType =
  | 'app-review-reply-to-moderator'
  | 'app-review-reply-to-developer';

export async function notifyAppReviewReply(opts: {
  type: AppReviewReplyNotificationType;
  userIds: number[];
  /** Idempotency key: one notification per stored message. */
  key: string;
  details: AppReviewReplyNotificationDetails;
}): Promise<void> {
  // An emit with no recipient would burn the key on a row nobody receives.
  if (opts.userIds.length === 0) return;
  const [{ createNotification }, { NotificationCategory }] = await Promise.all([
    import('~/server/services/notification.service'),
    import('~/server/common/enums'),
  ]);
  await createNotification({
    userIds: opts.userIds,
    category: NotificationCategory.System,
    type: opts.type,
    key: opts.key,
    details: opts.details,
  });
}
