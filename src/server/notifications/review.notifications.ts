import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const reviewNotifications = createNotificationProcessor(
  async ({ lastSent }, { prisma }) => {
    // Get all reviews added since lastSent
    const reviews = await prisma.review.findMany({
      where: {
        createdAt: { gt: lastSent },
      },
    });

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
    'new-review': {
      displayName: 'New Reviews',
      run: ({ details }) => ({
        message: `${details.username} reviewed ${details.modelName} ${details.modelVersionName}`,
        url: `/models/${details.modelId}?modal=review&reviewId=${details.reviewId}`, // Open up modal with review (or page if it's easier)
      }),
    },
  }
);
