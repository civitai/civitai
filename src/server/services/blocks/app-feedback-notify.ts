import type { AppFeedbackStatusDetails } from '~/server/notifications/app-feedback.notifications';
import {
  APP_FEEDBACK_STATUS_TYPE,
  appFeedbackNotifications,
} from '~/server/notifications/app-feedback.notifications';

/**
 * Emit `app-feedback-status` to a reporter. `createNotification` is imported lazily, as in
 * `app-listing-notify.ts`, so the service's unit tests need not load the notifications client; a
 * test that asserts emission mocks `~/server/services/notification.service`.
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
  const { createNotification } = await import('~/server/services/notification.service');
  await createNotification({
    userId: opts.userId,
    // The processor's own category, so the emitted row and the settings entry cannot disagree.
    category: appFeedbackNotifications[APP_FEEDBACK_STATUS_TYPE].category,
    type: APP_FEEDBACK_STATUS_TYPE,
    key: opts.key,
    details: opts.details,
  });
}
