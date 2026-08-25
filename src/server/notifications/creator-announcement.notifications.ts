import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const creatorAnnouncementNotifications = createNotificationProcessor({
  // No longer sent — a creator's announcement reaches followers through the Announcements tab
  // (`getFollowedAnnouncements`), which resolves the audience at read time. Fanning out a second
  // copy into Updates put the same announcement in two places and buried the tab that owns it.
  //
  // Kept, rather than deleted, because getNotificationMessage resolves at render time: dropping the
  // entry would blank out every notification already delivered. `toggleable: false` retires its
  // checkbox from the settings page, since there is no longer anything to toggle.
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
