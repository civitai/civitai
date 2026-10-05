import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const creatorMilestoneNotifications = createNotificationProcessor({
  'creator-score-tier-reached': {
    displayName: 'Creator Score tier reached',
    category: NotificationCategory.Milestone,
    prepareMessage: ({ details }) => {
      const unlocks = (details.unlocks as string[] | undefined) ?? [];
      const more = Number(details.moreUnlocks ?? 0);
      const unlocked = unlocks.length
        ? ` Unlocked: ${unlocks.join('; ')}${more > 0 ? `, and ${more} more` : ''}.`
        : '';
      return {
        message: `You reached ${details.tierName}, a Creator Score of ${Number(
          details.threshold
        ).toLocaleString()}.${unlocked}`,
        url: '/user/account#creator-score',
      };
    },
  },
});
