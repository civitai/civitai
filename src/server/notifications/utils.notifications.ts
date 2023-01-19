import { BareNotification, NotificationProcessor } from '~/server/notifications/base.notifications';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { modelNotifications } from '~/server/notifications/model.notifications';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';
import { reviewNotifications } from '~/server/notifications/review.notifications';
import { systemNotifications } from '~/server/notifications/system.notifications';
import { userJourneyNotifications } from '~/server/notifications/user-journey.notifications';

const notificationProcessors = {
  ...mentionNotifications,
  ...modelNotifications,
  ...reviewNotifications,
  ...commentNotifications,
  ...reactionNotifications,
  ...systemNotifications,
  ...userJourneyNotifications,
};

// Sort notifications by priority and group them by priority
const notificationBatches: NotificationProcessor[][] = [[]];
const notifications = Object.values(notificationProcessors).sort(
  (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
);
let currentBatch = notificationBatches[0];
for (const notification of notifications) {
  const priority = notification.priority ?? 0;
  if (priority !== currentBatch[0]?.priority) {
    currentBatch = [];
    notificationBatches.push(currentBatch);
  }
  currentBatch.push(notification);
}
export { notificationBatches };

export function getNotificationMessage(notification: BareNotification) {
  const { prepareMessage } = notificationProcessors[notification.type] ?? {};
  if (!prepareMessage) return null;
  return prepareMessage(notification);
}

export function getNotificationTypes() {
  const notificationTypes: Record<string, string> = {};
  for (const [type, { displayName, toggleable }] of Object.entries(notificationProcessors)) {
    if (toggleable !== false) notificationTypes[type] = displayName;
  }
  return notificationTypes;
}
