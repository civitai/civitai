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
    // `details.reason` is absent on every notification written before it existed, and on the paths
    // that still do not classify a removal — so the unreasoned wording stays, rather than rendering
    // "violation: undefined" over the whole backlog.
    prepareMessage: ({ details }) => ({
      message: details.reason
        ? `Your ${details.entity} on "${details.modelName}" has been removed for a Terms of Service violation: ${details.reason}.`
        : `Your ${details.entity} on "${details.modelName}" has been removed due to a Terms of Service violation.`,
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
  'system-message': {
    displayName: 'Heads Up!',
    category: NotificationCategory.Other,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.message,
      url: details.url,
    }),
  },
});
