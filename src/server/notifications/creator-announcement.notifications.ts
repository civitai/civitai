import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const creatorAnnouncementNotifications = createNotificationProcessor({
  // No longer fanned out — followers get these from the Announcements tab (`getFollowedAnnouncements`).
  // The entry stays because getNotificationMessage resolves at render time: deleting it would blank
  // out every notification already delivered.
  'creator-announcement': {
    displayName: 'Announcements from creators you follow',
    category: NotificationCategory.Update,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `${details.username} made an announcement: ${details.title}. Check it out.`,
      url: `/user/${details.username}?announcement=${details.announcementId}`,
    }),
  },
});
