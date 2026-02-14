import { articleNotifications } from '~/server/notifications/article.notifications';
import { comicNotifications } from '~/server/notifications/comics.notifications';
import { articleUnpublishNotifications } from '~/server/notifications/article-unpublish.notifications';
import { auctionNotifications } from '~/server/notifications/auction.notifications';
import type { BareNotification } from '~/server/notifications/base.notifications';
import { bountyNotifications } from '~/server/notifications/bounty.notifications';
import { buzzNotifications } from '~/server/notifications/buzz.notifications';
import { challengeNotifications } from '~/server/notifications/challenge.notifications';
import { clubNotifications } from '~/server/notifications/club.notifications';
import { collectionNotifications } from '~/server/notifications/collection.notifications';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { cosmeticShopNotifications } from '~/server/notifications/cosmetic-shop.notifications';
import { creatorsProgramNotifications } from '~/server/notifications/creators-program.notifications';
import { featuredNotifications } from '~/server/notifications/featured.notifications';
import { followNotifications } from '~/server/notifications/follow.notifications';
import { generationMuteNotifications } from '~/server/notifications/generation-mute.notifications';
import { imageNotifications } from '~/server/notifications/image.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { modelNotifications } from '~/server/notifications/model.notifications';
import { knightsNewOrderNotifications } from '~/server/notifications/new-order.notifications';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';
import { reportNotifications } from '~/server/notifications/report.notifications';
import { reviewNotifications } from '~/server/notifications/review.notifications';
import { systemNotifications } from '~/server/notifications/system.notifications';
import { unpublishNotifications } from '~/server/notifications/unpublish.notifications';
import { userJourneyNotifications } from '~/server/notifications/user-journey.notifications';

export const notificationProcessors = {
  ...mentionNotifications,
  ...modelNotifications,
  ...reviewNotifications,
  ...commentNotifications,
  ...reactionNotifications,
  ...systemNotifications,
  ...userJourneyNotifications,
  ...unpublishNotifications,
  ...articleNotifications,
  ...articleUnpublishNotifications,
  ...reportNotifications,
  ...featuredNotifications,
  ...bountyNotifications,
  ...buzzNotifications,
  ...collectionNotifications,
  ...imageNotifications,
  ...clubNotifications,
  ...creatorsProgramNotifications,
  ...followNotifications,
  ...generationMuteNotifications,
  ...cosmeticShopNotifications,
  ...challengeNotifications,
  ...auctionNotifications,
  ...knightsNewOrderNotifications,
  ...comicNotifications,
};

// Sort notifications by priority and group them by priority
const notifications = Object.entries(notificationProcessors)
  .map(([key, v]) => ({
    ...v,
    key,
  }))
  .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
const notificationPriorities: Record<number, typeof notifications> = {};
for (const notification of notifications) {
  const priority = notification.priority ?? 0;
  notificationPriorities[priority] ??= [];
  notificationPriorities[priority].push(notification);
}
export const notificationBatches = Object.keys(notificationPriorities)
  .sort()
  .map((key) => notificationPriorities[key as unknown as number]);

export function getNotificationMessage(notification: Omit<BareNotification, 'id'>) {
  const { prepareMessage } = notificationProcessors[notification.type] ?? {};
  if (!prepareMessage) return null;
  return prepareMessage(notification);
}

function getNotificationTypes() {
  const notificationTypes: string[] = [];
  const notificationCategoryTypes: Record<
    string,
    { displayName: string; type: string; defaultDisabled: boolean }[]
  > = {};
  for (const [
    type,
    { displayName, toggleable, category, defaultDisabled, showCategory },
  ] of Object.entries(notificationProcessors)) {
    if (toggleable === false && !showCategory) continue;
    notificationCategoryTypes[category] ??= [];
    notificationCategoryTypes[category]!.push({
      type,
      displayName,
      defaultDisabled: defaultDisabled ?? false,
    });
    notificationTypes.push(type);
  }

  return {
    notificationCategoryTypes,
    notificationTypes,
  };
}
export const { notificationCategoryTypes, notificationTypes } = getNotificationTypes();
