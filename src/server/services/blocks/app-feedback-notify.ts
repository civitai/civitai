import type { AppFeedbackStatusDetails } from '~/server/notifications/app-feedback.notifications';

/**
 * Emit `app-feedback-status` to a reporter. The `app-listing-notify.ts` shape: the only static
 * import is a TYPE, and `createNotification` is loaded inside the call, so importing this adds no
 * runtime graph to the service; a test that asserts emission mocks
 * `~/server/services/notification.service`.
 *
 * `createNotification` is best-effort (it swallows client errors), and the notifications service
 * drops a recipient who has a `UserNotificationSettings` row for the type — that row is the
 * reporter's opt-out.
 */
export async function notifyAppFeedbackReporter(opts: {
  userId: number;
  /** `appFeedbackStatusKey(feedbackId, ownerStatus)` — one delivery per (feedback, status). */
  key: string;
  details: AppFeedbackStatusDetails;
}): Promise<void> {
  const [{ createNotification }, { APP_FEEDBACK_STATUS_TYPE, appFeedbackNotifications }] =
    await Promise.all([
      import('~/server/services/notification.service'),
      import('~/server/notifications/app-feedback.notifications'),
    ]);
  await createNotification({
    userId: opts.userId,
    // The processor's own category, so the emitted row and the settings entry cannot disagree.
    category: appFeedbackNotifications[APP_FEEDBACK_STATUS_TYPE].category,
    type: APP_FEEDBACK_STATUS_TYPE,
    key: opts.key,
    details: opts.details,
  });
}
