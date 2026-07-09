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
      // Actor-neutral copy: this notification can fire either from a mod
      // resolution or from the auto-approve path (resolvedBy = system user).
      // Avoid falsely attributing the auto-approved case to a moderator.
      const base = `Your rating dispute on "${articleTitle}" was approved — the rating was updated from ${previousLevel} to ${newLevel}.`;
      return {
        message: modComment ? `${base} Moderator note: ${modComment}` : base,
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
      // `prepareMessage` runs at render time over the stored `details`, so this
      // must handle both shapes: pre-single-action rows carry `currentLevel`
      // (the rating that was kept on a decline); new rows carry `appliedLevel`
      // (the level the moderator now always sets). Without the `currentLevel`
      // fallback, legacy rows would render "...set the rating to undefined".
      const { articleTitle, articleId, appliedLevel, currentLevel, modComment } = details as {
        articleTitle: string;
        articleId: number;
        appliedLevel?: number | string;
        currentLevel?: number | string;
        modComment?: string;
      };
      const base =
        appliedLevel != null
          ? `Your rating dispute on "${articleTitle}" was reviewed — a moderator set the rating to ${appliedLevel}.`
          : `Your rating dispute on "${articleTitle}" was declined — the current rating (${currentLevel}) was kept.`;
      return {
        message: modComment ? `${base} Reason: ${modComment}` : base,
        url: `/articles/${articleId}`,
      };
    },
  },
});
