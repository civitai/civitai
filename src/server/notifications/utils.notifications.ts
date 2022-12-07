import { reviewNotifications } from '~/server/notifications/review.notifications';

export const notificationProcessors = [reviewNotifications];

export function getNotificationMessage(notification: Notification) {
  const { types } = notificationProcessors.find((x) => x.types?.[notification.type]) ?? {};
  if (!types) return null;
  return types?.[notification.type]?.(notification);
}
