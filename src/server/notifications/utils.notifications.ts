import { BareNotification } from '~/server/notifications/base.notifications';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { modelNotifications } from '~/server/notifications/model.notifications';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';
import { reviewNotifications } from '~/server/notifications/review.notifications';
import { systemNotifications } from '~/server/notifications/system.notifications';

export const notificationProcessors = {
  ...reviewNotifications,
  ...reactionNotifications,
  ...modelNotifications,
  ...systemNotifications,
  ...commentNotifications,
};

export function getNotificationMessage(notification: BareNotification) {
  const { prepareMessage } = notificationProcessors[notification.type] ?? {};
  if (!prepareMessage) return null;
  return prepareMessage(notification);
}

export function getNotificationTypes() {
  const notificationTypes: Record<string, string> = {};
  for (const [type, { displayName }] of Object.entries(notificationProcessors)) {
    notificationTypes[type] = displayName;
  }
  return notificationTypes;
}
