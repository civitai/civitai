import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const systemNotifications = createNotificationProcessor({
  'civitai-features': {
    displayName: 'New Civitai features',
    prepareMessage: ({ details }) => ({
      message: `New Features! ${details.featureBlurb}, check it out!`,
      url: `/content/release/${details.releaseSlug}`,
    }),
  },
  'tos-violation': {
    displayName: 'Terms of Service Violation',
    prepareMessage: ({ details }) => ({
      message: `Your ${details.entity} at ${details.modelName} has been removed due to a Terms of Service violation.`,
    }),
  },
});
