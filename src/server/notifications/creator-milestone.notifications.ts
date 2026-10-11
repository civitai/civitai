import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';

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
  'creator-legend-reached-staff': {
    displayName: 'New Legend (staff)',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) =>
      details?.username
        ? {
            message: `${details.username} just became a Legend. Send them a note?`,
            url: `/user/${details.username}`,
          }
        : undefined,
  },
  'creator-milestone-reached': {
    displayName: 'Creator milestone reached',
    category: NotificationCategory.Milestone,
    prepareMessage: ({ details }) => ({
      message: `Milestone unlocked: ${details.name}. See it on your Creator Journey.`,
      url: CREATOR_JOURNEY_HREF,
    }),
  },
});
