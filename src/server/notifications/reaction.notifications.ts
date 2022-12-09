import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const reactionNotifications = createNotificationProcessor({
  'comment-reaction-milestone': {
    displayName: 'Comment Reaction Milestones',
    prepareMessage: ({ details }) => ({
      message: `Your comment on ${details.modelName} has recieved ${details.reactionCount} reactions`,
      url: `/model/${details.modelId}?modal=comment&commentId=${details.rootCommentId}`,
    }),
    prepareQuery: ({ lastSent }) => ``,
  },
  'review-reaction-milestone': {
    displayName: 'Review Reaction Milestones',
    prepareMessage: ({ details }) => ({
      message: `Your review on ${details.modelName} has recieved ${details.reactionCount} reactions`,
      url: `/model/${details.modelId}?modal=review&reviewId=${details.reviewId}`,
    }),
    prepareQuery: ({ lastSent }) => ``,
  },
});
