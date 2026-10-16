import { SERVICE_OFFERING_TAKEN_DOWN } from '@civitai/shared/service-offering-takedown';
import { NotificationCategory } from '~/server/common/enums';
import { getServiceOfferingTakedownReason } from '~/server/common/moderation-helpers';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const creatorServiceNotifications = createNotificationProcessor({
  // Sent once to the seller when a moderator takes their offering down. Never names the moderator.
  [SERVICE_OFFERING_TAKEN_DOWN]: {
    displayName: 'Service taken down',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const reasonCopy =
        details.reason === 'other'
          ? details.details
          : getServiceOfferingTakedownReason(details.reason)?.notificationMessage;
      const service = `Your service "${details.offeringTitle}" has been removed by a moderator`;
      return {
        message: reasonCopy ? `${service}: ${reasonCopy}` : `${service}.`,
        url: details.sellerUsername ? `/user/${details.sellerUsername}/shop/manage` : undefined,
      };
    },
  },
});
