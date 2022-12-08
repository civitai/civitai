import { BareNotification } from '~/server/notifications/base.notifications';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';
import { reviewNotifications } from '~/server/notifications/review.notifications';

export const notificationProcessors = [reviewNotifications, reactionNotifications];

export function getNotificationMessage(notification: BareNotification) {
  const { types } = notificationProcessors.find((x) => x.types?.[notification.type]) ?? {};
  if (!types) return null;
  return types?.[notification.type]?.run(notification);
}

export function getNotificationTypes() {
  const notificationTypes: Record<string, string> = {};
  for (const { types } of notificationProcessors) {
    if (!types) continue;

    for (const [key, { displayName }] of Object.entries(types)) {
      notificationTypes[key] = displayName;
    }
  }

  return notificationTypes;
}
