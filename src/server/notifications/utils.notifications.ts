import { articleNotifications } from '~/server/notifications/article.notifications';
import { comicNotifications } from '~/server/notifications/comics.notifications';
import { articleRatingReviewNotifications } from '~/server/notifications/article-rating-review.notifications';
import { articleUnpublishNotifications } from '~/server/notifications/article-unpublish.notifications';
import { appBlockNotifications } from '~/server/notifications/app-block.notifications';
import { appListingNotifications } from '~/server/notifications/app-listing.notifications';
import { auctionNotifications } from '~/server/notifications/auction.notifications';
import type { BareNotification } from '~/server/notifications/base.notifications';
import { bountyNotifications } from '~/server/notifications/bounty.notifications';
import { buzzNotifications } from '~/server/notifications/buzz.notifications';
import { membershipGiftNotifications } from '~/server/notifications/membership-gift.notifications';
import { challengeNotifications } from '~/server/notifications/challenge.notifications';
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
import { strikeNotifications } from '~/server/notifications/strike.notifications';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';
import { reportNotifications } from '~/server/notifications/report.notifications';
import { reviewNotifications } from '~/server/notifications/review.notifications';
import { systemNotifications } from '~/server/notifications/system.notifications';
import { unpublishNotifications } from '~/server/notifications/unpublish.notifications';
import { userJourneyNotifications } from '~/server/notifications/user-journey.notifications';
import { referralNotifications } from '~/server/notifications/referral.notifications';

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
  ...appListingNotifications,
  ...appBlockNotifications,
  ...articleRatingReviewNotifications,
  ...reportNotifications,
  ...featuredNotifications,
  ...bountyNotifications,
  ...buzzNotifications,
  ...collectionNotifications,
  ...imageNotifications,
  ...creatorsProgramNotifications,
  ...followNotifications,
  ...generationMuteNotifications,
  ...cosmeticShopNotifications,
  ...challengeNotifications,
  ...auctionNotifications,
  ...knightsNewOrderNotifications,
  ...comicNotifications,
  ...strikeNotifications,
  ...referralNotifications,
  ...membershipGiftNotifications,
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
// Numeric sort, not lexicographic: `send-notifications` runs these batches in order and the comment
// family relies on that order to decide which of several competing notifications wins the shared dedupe
// key. A default .sort() would put priority 10 ahead of priority 2.
export const notificationBatches = Object.keys(notificationPriorities)
  .map(Number)
  .sort((a, b) => a - b)
  .map((key) => notificationPriorities[key]);

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
