import { createDetailFetcher } from '~/server/notifications/detail-fetchers/base.detail-fetcher';
import { featuredNotifications } from '~/server/notifications/featured.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { modelNotifications } from '~/server/notifications/model.notifications';
import { getSfwModelNames } from '~/server/services/model-sfw-face.service';
import { withSfwModelNames } from '~/shared/utils/model-sfw-face';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { minorFlagNotifications } from '~/server/notifications/minor-flag.notifications';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';
import { reviewNotifications } from '~/server/notifications/review.notifications';
import { unpublishNotifications } from '~/server/notifications/unpublish.notifications';

/**
 * Renders a model's .com title at read time. The name is stored when the notification is written,
 * for a recipient whose site is unknown, and a face set later would never reach it.
 */
export const modelFaceDetailFetcher = createDetailFetcher({
  types: [
    ...Object.keys(modelNotifications),
    ...Object.keys(featuredNotifications),
    ...Object.keys(mentionNotifications),
    ...Object.keys(commentNotifications),
    ...Object.keys(reviewNotifications),
    ...Object.keys(reactionNotifications),
    ...Object.keys(unpublishNotifications),
    ...Object.keys(minorFlagNotifications),
  ],
  fetcher: async (notifications, { showSfwFace }) => {
    const named = notifications.filter(
      (n) => typeof n.details.modelId === 'number' && typeof n.details.modelName === 'string'
    );
    const sfwNames = await getSfwModelNames(
      named.map((n) => n.details.modelId as number),
      showSfwFace
    );
    const renamed = withSfwModelNames(
      named.map((n) => n.details as { modelId: number; modelName: string }),
      sfwNames
    );
    named.forEach((n, i) => (n.details = renamed[i]));
  },
});
