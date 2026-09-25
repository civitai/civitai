import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';

const entityNoun: Record<string, string> = {
  Model: 'model',
  Article: 'article',
  Post: 'post',
  Bounty: 'bounty',
  BountyEntry: 'bounty entry',
};

export const textScanNotifications = createNotificationProcessor({
  'text-scan-rating-raised': {
    displayName: 'Content rating raised',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const { entityType, level, title, url } = details as {
        entityType: string;
        level: number;
        title: string | null;
        url: string;
      };
      const noun = entityNoun[entityType] ?? 'content';
      const label = browsingLevelLabels[level as keyof typeof browsingLevelLabels] ?? '?';
      const named = title ? `${noun} "${title}"` : noun;
      return {
        message: `Your ${named} is now rated ${label} based on its text. If you believe this is a mistake, you can dispute the rating on its page.`,
        url,
      };
    },
  },
});
