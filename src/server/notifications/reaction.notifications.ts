import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { prisma } from '~/server/db/client';

export const reactionNotifications = createNotificationProcessor(
  async ({ lastSent }) => {
    const where = {
      createdAt: { gt: lastSent },
    };

    // Get the comments and reviews with reactions added since lastSent
    // Sum the total of the reactions for each of the affected
    // Create notifications for each review or comment that has exceeded the thresholds that don't already have a notification matching that threshold
    /*
      type: 'comment-reaction-count-notification',
      userId: comment.userId,
      details: {
        commentId,
        modelId,
        modelName,
        commentBody.truncate(20),
        threshold,
      }
    */

    // Create notifications
    const newReviewNotification = reviews
      .filter((x) => x) // Filter to ones that apply
      .map((review) => ({
        /* // create notification here
      userId, // The owner of the model being reviewed
      type: 'new-review',
      details: {
        reviewerUserId: 1, // The user who created the review
        username: 'jimbob',
        modelVersionId,
        reviewId,
        modelId,
        modelName,
        modelVersionName,
      }, */
      }));

    // Send Browser Notifications

    // CreateMany with prisma

    // Return the sent notifications
    return {
      success: true,
      sent: {
        'new-review': newReviewNotification.length,
      },
    };
  },
  {
    'comment-reaction-milestone': ({ details }) => ({
      message: `Go see your comment on ${details.modelName}: "${details.commentSample}..."`,
      url: `/model/${details.modelId}?modal=comment&commentId=${details.rootCommentId}`,
    }),
  }
);
