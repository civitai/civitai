import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const articleRatingReviewNotifications = createNotificationProcessor({
  'article-rating-review-approved': {
    displayName: 'Article rating dispute approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const { articleTitle, articleId, previousLevel, newLevel, modComment } = details as {
        articleTitle: string;
        articleId: number;
        previousLevel: number | string;
        newLevel: number | string;
        modComment?: string;
      };
      const base = `A moderator reviewed your dispute on "${articleTitle}" and updated the rating from ${previousLevel} to ${newLevel}.`;
      return {
        message: modComment ? `${base} Note from moderator: ${modComment}` : base,
        url: `/articles/${articleId}`,
      };
    },
  },
  'article-rating-review-rejected': {
    displayName: 'Article rating dispute declined',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const { articleTitle, articleId, currentLevel, modComment } = details as {
        articleTitle: string;
        articleId: number;
        currentLevel: number | string;
        modComment?: string;
      };
      const base = `A moderator reviewed your dispute on "${articleTitle}" and the current rating (${currentLevel}) was kept.`;
      return {
        message: modComment ? `${base} Reason: ${modComment}` : base,
        url: `/articles/${articleId}`,
      };
    },
  },
});
