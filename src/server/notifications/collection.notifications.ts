import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const collectionNotifications = createNotificationProcessor({
  'contest-collection-item-status-change': {
    displayName: 'Your item has been reviewed',
    prepareMessage: ({ details }) => ({
      message: `The item you submitted to the contest "${details.collectionName}" has been ${details.status}.`,
      url: details.imageId
        ? `/images/${details.imageId}`
        : details.modelId
        ? `/model/${details.modelId}`
        : details.articleId
        ? `/articles/${details.articleId}`
        : details.postId
        ? `/posts/${details.postId}`
        : `/collections/${details.collectionId}`,
    }),
  },
});
