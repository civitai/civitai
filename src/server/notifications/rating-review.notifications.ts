import type { RatingReviewNotificationDetails } from '@civitai/shared/rating-review';
import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const ratingReviewNotifications = createNotificationProcessor({
  'rating-review-approved': {
    displayName: 'Rating dispute approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const { title, url, previousLevel, appliedLevel, modComment } =
        details as RatingReviewNotificationDetails;
      const base = `Your rating dispute on "${title}" was approved — the rating was updated from ${previousLevel} to ${appliedLevel}.`;
      return { message: modComment ? `${base} Moderator note: ${modComment}` : base, url };
    },
  },
  'rating-review-rejected': {
    displayName: 'Rating dispute declined',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const { title, url, appliedLevel, modComment } = details as RatingReviewNotificationDetails;
      const base = `Your rating dispute on "${title}" was reviewed — a moderator set the rating to ${appliedLevel}.`;
      return { message: modComment ? `${base} Reason: ${modComment}` : base, url };
    },
  },
});
