import { articleNotifications } from '~/server/notifications/article.notifications';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';
import { comicNotifications } from '~/server/notifications/comics.notifications';
import { articleRatingReviewNotifications } from '~/server/notifications/article-rating-review.notifications';
import { ratingReviewNotifications } from '~/server/notifications/rating-review.notifications';
import { articleUnpublishNotifications } from '~/server/notifications/article-unpublish.notifications';
import { creatorServiceNotifications } from '~/server/notifications/creator-service.notifications';
import { appAccessRequestNotifications } from '~/server/notifications/app-access-request.notifications';
import { appBlockNotifications } from '~/server/notifications/app-block.notifications';
import { appBuzzRefundNotifications } from '~/server/notifications/app-buzz-refund.notifications';
import { appCollaboratorNotifications } from '~/server/notifications/app-collaborator.notifications';
import { appFeedbackNotifications } from '~/server/notifications/app-feedback.notifications';
import { appListingNotifications } from '~/server/notifications/app-listing.notifications';
import { appModeratorMessageNotifications } from '~/server/notifications/app-moderator-message.notifications';
import { appPlatformUpdateNotifications } from '~/server/notifications/app-platform-update.notifications';
import { auctionNotifications } from '~/server/notifications/auction.notifications';
import type { BareNotification } from '~/server/notifications/base.notifications';
import {
  MISSED_DIGEST_DISPLAY_NAME,
  MISSED_DIGEST_EMAIL_TYPE,
} from '~/server/notifications/missed-digest.constants';
import { bountyNotifications } from '~/server/notifications/bounty.notifications';
import { buzzNotifications } from '~/server/notifications/buzz.notifications';
import { membershipGiftNotifications } from '~/server/notifications/membership-gift.notifications';
import { modelVersionGiftNotifications } from '~/server/notifications/model-version-gift.notifications';
import { challengeNotifications } from '~/server/notifications/challenge.notifications';
import { collectionNotifications } from '~/server/notifications/collection.notifications';
import { commentNotifications } from '~/server/notifications/comment.notifications';
import { crucibleNotifications } from '~/server/notifications/crucible.notifications';
import { cosmeticShopNotifications } from '~/server/notifications/cosmetic-shop.notifications';
import { placementNotifications } from '~/server/notifications/placement.notifications';
import {
  storylineNotifications,
  storylineOwnerNotifications,
  storylineInviteNotifications,
  storylineFollowNotifications,
} from '~/server/notifications/storyline.notifications';
import { creatorsProgramNotifications } from '~/server/notifications/creators-program.notifications';
import { featuredNotifications } from '~/server/notifications/featured.notifications';
import { creatorMilestoneNotifications } from '~/server/notifications/creator-milestone.notifications';
import { creatorAnnouncementNotifications } from '~/server/notifications/creator-announcement.notifications';
import { followNotifications } from '~/server/notifications/follow.notifications';
import { generationMuteNotifications } from '~/server/notifications/generation-mute.notifications';
import { reviewMuteNotifications } from '~/server/notifications/review-mute.notifications';
import { imageNotifications } from '~/server/notifications/image.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { minorFlagNotifications } from '~/server/notifications/minor-flag.notifications';
import { textScanFlagNotifications } from '~/server/notifications/text-scan-flag.notifications';
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
import { textScanNotifications } from '~/server/notifications/text-scan.notifications';

export const notificationProcessors = {
  ...creatorAnnouncementNotifications,
  ...mentionNotifications,
  ...modelNotifications,
  ...reviewNotifications,
  ...commentNotifications,
  ...reactionNotifications,
  ...systemNotifications,
  ...userJourneyNotifications,
  ...unpublishNotifications,
  ...minorFlagNotifications,
  ...textScanFlagNotifications,
  ...articleNotifications,
  ...articleUnpublishNotifications,
  ...creatorServiceNotifications,
  ...appListingNotifications,
  ...appAccessRequestNotifications,
  ...appBlockNotifications,
  ...appBuzzRefundNotifications,
  ...appCollaboratorNotifications,
  ...appFeedbackNotifications,
  ...appModeratorMessageNotifications,
  ...appPlatformUpdateNotifications,
  ...articleRatingReviewNotifications,
  ...ratingReviewNotifications,
  ...reportNotifications,
  ...featuredNotifications,
  ...bountyNotifications,
  ...placementNotifications,
  ...storylineNotifications,
  ...storylineOwnerNotifications,
  ...storylineInviteNotifications,
  ...storylineFollowNotifications,
  ...buzzNotifications,
  ...collectionNotifications,
  ...imageNotifications,
  ...creatorsProgramNotifications,
  ...followNotifications,
  ...generationMuteNotifications,
  ...reviewMuteNotifications,
  ...cosmeticShopNotifications,
  ...challengeNotifications,
  ...crucibleNotifications,
  ...auctionNotifications,
  ...knightsNewOrderNotifications,
  ...comicNotifications,
  ...strikeNotifications,
  ...referralNotifications,
  ...membershipGiftNotifications,
  ...modelVersionGiftNotifications,
  ...textScanNotifications,
  ...creatorMilestoneNotifications,
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
  const optInNotificationTypes: string[] = [];
  type SettingRow = { displayName: string; type: string; optIn: boolean };
  const notificationCategoryTypes: Record<string, SettingRow[]> = {};
  const notificationSectionTypes: Record<string, SettingRow[]> = {};
  const notificationGroupFeatures: Record<string, FeatureFlagKey> = {};
  for (const [
    type,
    { displayName, toggleable, category, section, optIn, showCategory, feature },
  ] of Object.entries(notificationProcessors)) {
    if (toggleable === false && !showCategory) continue;
    const groups = section ? notificationSectionTypes : notificationCategoryTypes;
    const group = section ?? category;
    if (feature) notificationGroupFeatures[group] = feature;
    groups[group] ??= [];
    groups[group]!.push({ type, displayName, optIn: optIn ?? false });
    if (optIn) optInNotificationTypes.push(type);
    else notificationTypes.push(type);
  }

  return {
    notificationCategoryTypes,
    notificationSectionTypes,
    notificationGroupFeatures,
    notificationTypes,
    optInNotificationTypes,
  };
}
/**
 * `notificationTypes` deliberately EXCLUDES opt-in types — it is the list the bulk on/off toggles
 * send, and for an opt-in type "off" writes the row that subscribes you. Those types are still
 * present in `notificationCategoryTypes` so they render their own checkbox.
 */
export const {
  notificationCategoryTypes,
  notificationSectionTypes,
  notificationGroupFeatures,
  notificationTypes,
  optInNotificationTypes,
} = getNotificationTypes();

/**
 * What the settings pages list, each under its own heading: the categories, then the sections (types
 * that name a `section` are grouped there instead of under their category).
 */
export const notificationSettingGroups = {
  ...notificationCategoryTypes,
  ...notificationSectionTypes,
};

/** The settings groups this viewer may see: a group whose types name a `feature` shows only while it is on. */
export const visibleNotificationSettingGroups = (
  features: Partial<Record<FeatureFlagKey, boolean>>
) =>
  Object.fromEntries(
    Object.entries(notificationSettingGroups).filter(([group]) => {
      const feature = notificationGroupFeatures[group];
      return !feature || features[feature] === true;
    })
  );

export const isOptInNotification = (type: string) => optInNotificationTypes.includes(type);

/**
 * Push may target exactly the types that render a control — registered and toggleable. Gates the
 * `updatePushSettings` insert so a direct API client can't create rows for unknown or
 * non-toggleable (system/moderation) types the UI never exposes.
 */
export const isPushableNotificationType = (type: string) => {
  const processor = notificationProcessors[type];
  return !!processor && processor.toggleable !== false;
};

export const emailNotificationTypeList = Object.entries(notificationProcessors)
  .filter(([, processor]) => processor.defaultEmail)
  .map(([type]) => type);

export const isEmailNotificationType = (type: string) => emailNotificationTypeList.includes(type);

/**
 * Every type a user can turn email off for: the notification types that email, plus the weekly
 * digest, which is an email of its own and not a notification type. The opt-out table, the settings
 * toggle and the one-click unsubscribe accept exactly these; only the first group is ever sent by
 * the per-notification email path.
 */
export const emailOptOutTypeList = [...emailNotificationTypeList, MISSED_DIGEST_EMAIL_TYPE];

export const isEmailOptOutType = (type: string) => emailOptOutTypeList.includes(type);

/** What an email opt-out type is called on the unsubscribe page and in emails. */
export const emailOptOutDisplayName = (type: string) =>
  type === MISSED_DIGEST_EMAIL_TYPE
    ? MISSED_DIGEST_DISPLAY_NAME
    : notificationProcessors[type]?.displayName ?? type;

/**
 * Email types with no on-site toggle (`toggleable: false`, so no settings row and no per-type
 * control). The settings pages list them on their own as email-only checkboxes, so a user who used
 * the one-click unsubscribe can find the email again where the email's "Manage" link sends them.
 */
export const systemEmailNotificationTypes = Object.entries(notificationProcessors)
  .filter(([, processor]) => processor.defaultEmail && processor.toggleable === false)
  .map(([type, { displayName }]) => ({ type, displayName }));

/**
 * The opt-out types whose settings rows say whether a user turned everything off: every type the
 * "all notifications" switch writes a row for, less the ones another app sends. The Knights job reads
 * this over HTTP (`/api/mod/knights/notification-types`) to leave out users who silenced them all.
 */
export const silenceCheckTypes = notificationTypes.filter(
  (type) => !notificationProcessors[type]?.externalProducer
);
