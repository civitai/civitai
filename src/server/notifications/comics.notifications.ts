import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { slugit } from '~/utils/string-helpers';

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
  // Added so the notification can deep-link to the chapter reader (where
  // comments are actually rendered) and scroll to the specific comment.
  // Optional for backwards-compat with notifications inserted before this
  // change — those fall back to the project URL.
  chapterPosition?: number;
  commentId?: number;
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
      const projectSlug = slugit(det.comicProjectName || 'comic');
      const chapterSlug = slugit(det.chapterName || 'chapter');
      const url =
        det.chapterPosition != null && det.commentId != null
          ? `/comics/${det.comicProjectId}/${projectSlug}/${
              det.chapterPosition + 1
            }/${chapterSlug}?highlight=${det.commentId}`
          : `/comics/${det.comicProjectId}`;
      return {
        message: `${det.commenterUsername} commented on "${det.chapterName}" in "${det.comicProjectName}"`,
        url,
      };
    },
  },
});
