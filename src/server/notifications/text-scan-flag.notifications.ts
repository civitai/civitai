import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { slugit } from '~/utils/string-helpers';

const depicting: Record<string, string> = { poi: 'a real person', minor: 'a minor' };

export const textScanFlagNotifications = createNotificationProcessor({
  'model-text-scan-flagged': {
    displayName: 'Model restricted by automated review',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your model ${details.modelName} has been marked as depicting ${
        depicting[details.label] ?? 'restricted content'
      } and restricted to SFW generation. If you believe this is a mistake, you can request a review on the model page.`,
      url: `/models/${details.modelId}/${slugit(details.modelName)}`,
    }),
  },
  'bounty-text-scan-flagged': {
    displayName: 'Bounty hidden by automated review',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your bounty ${details.bountyName} has been hidden because it appears to depict a real person. If you believe this is a mistake, you can request a review on the bounty page.`,
      url: `/bounties/${details.bountyId}`,
    }),
  },
});
