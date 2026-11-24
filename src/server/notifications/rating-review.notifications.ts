import type { RatingReviewNotificationDetails } from '@civitai/shared/rating-review';
import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

const subject = ({ entityType, title }: RatingReviewNotificationDetails) =>
  entityType === 'Song' ? `your song "${title}"` : `"${title}"`;

export const ratingReviewNotifications = createNotificationProcessor({
  'rating-review-approved': {
    displayName: 'Rating dispute approved',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const d = details as RatingReviewNotificationDetails;
      const { url, previousLevel, appliedLevel, modComment } = d;
      const base = `Your rating dispute on ${subject(
        d
      )} was approved — the rating was updated from ${previousLevel} to ${appliedLevel}.`;
      return { message: modComment ? `${base} Moderator note: ${modComment}` : base, url };
    },
  },
  'rating-review-rejected': {
    displayName: 'Rating dispute declined',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const d = details as RatingReviewNotificationDetails;
      const { url, appliedLevel, modComment } = d;
      const base = `Your rating dispute on ${subject(
        d
      )} was reviewed — a moderator set the rating to ${appliedLevel}.`;
      return { message: modComment ? `${base} Reason: ${modComment}` : base, url };
    },
  },
});
