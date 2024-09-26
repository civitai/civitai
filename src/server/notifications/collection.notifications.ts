import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const collectionNotifications = createNotificationProcessor({
  'contest-collection-item-status-change': {
    displayName: 'Your item has been reviewed',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => ({
      message: `The item you submitted to the contest "${details.collectionName}" has been ${details.status}.`,
      url: details.imageId
        ? `/images/${details.imageId}`
        : details.modelId
        ? `/models/${details.modelId}`
        : details.articleId
        ? `/articles/${details.articleId}`
        : details.postId
        ? `/posts/${details.postId}`
        : `/collections/${details.collectionId}`,
    }),
  },
  'beggars-board-rejected': {
    displayName: 'Beggars board entry declined',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `Your entry to the Buzz Beggars Board was declined. Try again!`,
      url: `/collections/3870938`,
    }),
  },
  'beggars-board-expired': {
    displayName: 'Beggars board entry expired',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `Your submission to the Buzz Beggars Board has expired. Time to make a new entry!`,
      url: `/collections/3870938`,
    }),
  },
  'collection-update': {
    displayName: 'New items added to a collection you follow',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `New items have been added to the "${details.collectionName}" collection.`,
      url: `/collections/${details.collectionId}`,
    }),
  },
});
