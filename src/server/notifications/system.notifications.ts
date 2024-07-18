import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const systemNotifications = createNotificationProcessor({
  'civitai-features': {
    displayName: 'New Civitai features',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: `New Features! ${details.featureBlurb}, check it out!`,
      url: `/content/release/${details.releaseSlug}`,
    }),
  },
  'tos-violation': {
    displayName: 'Terms of Service Violation',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your ${details.entity} on "${details.modelName}" has been removed due to a Terms of Service violation.`,
      url: details.url,
    }),
  },
  'system-announcement': {
    displayName: 'System Announcement',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.message,
      url: details.url,
    }),
  },
});
