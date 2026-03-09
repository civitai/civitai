import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export type NotifDetailsNewComicChapter = {
  comicProjectId: string;
  comicProjectName: string;
  chapterName: string;
  authorUsername: string;
};

export type NotifDetailsComicComment = {
  comicProjectId: string;
  comicProjectName: string;
  chapterName: string;
  commenterUsername: string;
};

export const comicNotifications = createNotificationProcessor({
  'new-comic-chapter': {
    displayName: 'New comic chapter',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => {
      const det = details as NotifDetailsNewComicChapter;
      return {
        message: `${det.authorUsername} published a new chapter "${det.chapterName}" in "${det.comicProjectName}"`,
        url: `/comics/${det.comicProjectId}`,
      };
    },
  },
  'new-comic-comment': {
    displayName: 'New comic comment',
    category: NotificationCategory.Comment,
    prepareMessage: ({ details }) => {
      const det = details as NotifDetailsComicComment;
      return {
        message: `${det.commenterUsername} commented on "${det.chapterName}" in "${det.comicProjectName}"`,
        url: `/comics/${det.comicProjectId}`,
      };
    },
  },
});
