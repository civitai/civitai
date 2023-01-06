import { BareNotification } from '~/server/notifications/base.notifications';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { modelNotifications } from '~/server/notifications/model.notifications';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';
import { reviewNotifications } from '~/server/notifications/review.notifications';
import { systemNotifications } from '~/server/notifications/system.notifications';
import { userJourneyNotifications } from '~/server/notifications/user-journey.notifications';

export const notificationProcessors = {
  ...modelNotifications,
  ...reviewNotifications,
  ...commentNotifications,
  ...reactionNotifications,
  ...systemNotifications,
  ...userJourneyNotifications,
};

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
