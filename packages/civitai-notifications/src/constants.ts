// Notification category + signal-type constants. Single source of truth shared by every producer
// (the monolith, the orchestrator gateway, future apps) and the notifications app itself, so the
// enum can't drift between the create path, the fan-out worker, and the DB `NotificationCategory`
// type.

export const notificationCategories = [
  'Comment',
  'Update',
  'Milestone',
  'Bounty',
  'Buzz',
  'Creator',
  'Referral',
  'System',
  'Moderation',
  'Other',
] as const;

export type NotificationCategory = (typeof notificationCategories)[number];

/** Enum-style accessor mirroring the monolith's `NotificationCategory` enum (value === key). */
export const NotificationCategory = Object.fromEntries(
  notificationCategories.map((c) => [c, c])
) as { [K in NotificationCategory]: K };

/**
 * Realtime signal type POSTed to the signals service per affected user after fan-out
 * (`${SIGNALS_ENDPOINT}/users/{userId}/signals/{newNotificationSignal}`). The client subscribes to
 * this to bump its unread badge without a poll.
 */
export const newNotificationSignal = 'notification:new';

/**
 * Types that send email: the processors with `defaultEmail` (a main-app test pins the two). The
 * fan-out worker has no registry, so it gates on this list.
 */
export const emailNotificationTypes: readonly string[] = [
  'service-deal-requested',
  'service-deal-accepted',
  'service-deal-declined',
  'service-deal-expired',
  'service-deal-delivered',
  'service-deal-revision-requested',
  'service-deal-cancellation-requested',
  'service-deal-completed',
  'service-deal-paid-out',
];

/**
 * The opt-out types that existed when the Knights of New Order types were added. A user with a
 * settings row for every one of them turned everything off in notification settings, which writes
 * rows only for the types that exist at that moment, so a later type reads as on for them. A sender of
 * such a type uses this to leave those users out. A main-app test pins every entry to a registered
 * opt-out type; the list never has to grow.
 */
export const optOutTypesBeforeKnights: readonly string[] = [
  'new-mention',
  'model-download-milestone',
  'model-like-milestone',
  'new-model-version',
  'new-model-from-following',
  'new-review',
  'new-comment',
  'new-comment-response',
  'new-comment-nested',
  'new-comment-reply',
  'new-thread-response',
  'new-review-response',
  'new-image-comment',
  'new-post-comment',
  'new-app-listing-comment',
  'new-article-comment',
  'new-bounty-comment',
  'new-bounty-entry-comment',
  'new-challenge-comment',
  'new-crucible-comment',
  'new-storyline-comment',
  'new-3d-model-comment',
  'new-3d-model-comment-response',
  'new-3d-model-comment-nested',
  'comment-reaction-milestone',
  'image-reaction-milestone',
  'article-reaction-milestone',
  'civitai-features',
  'model-flagged-minor',
  'model-text-scan-flagged',
  'bounty-text-scan-flagged',
  'article-view-milestone',
  'article-like-milestone',
  'new-article-from-following',
  'service-deal-requested',
  'service-deal-accepted',
  'service-deal-declined',
  'service-deal-expired',
  'service-deal-delivered',
  'service-deal-revision-requested',
  'service-deal-cancellation-requested',
  'service-deal-completed',
  'service-deal-paid-out',
  'app-feedback-new',
  'app-feedback-status',
  'bounty-ending',
  'bounty-awarded',
  'bounty-reaction-milestone',
  'bounty-entry',
  'sticker-placement-pending',
  'sticker-placement-free-pending',
  'remix-gallery-pending',
  'remix-gallery-free-pending',
  'remix-gallery-resolved',
  'remix-gallery-undelivered',
  'sticker-placement-resolved',
  'storyline-continuation-submitted',
  'storyline-continuation-approved',
  'storyline-continuation-declined',
  'storyline-ceiling-raised',
  'tip-received',
  'collection-item-accepted',
  'collection-item-rejected',
  'collection-update',
  'collection-submission-received',
  'collection-invite-received',
  'profile-picture-blocked',
  'creator-program-banking-phase-ending',
  'creator-program-extraction-phase-started',
  'creator-program-extraction-phase-ending',
  'creator-program-funds-settled',
  'followed-by',
  'creator-shop-item-approved',
  'creator-shop-item-changes-requested',
  'creator-shop-item-reverted',
  'creator-shop-item-rejected',
  'creator-shop-resale-ended',
  'creator-shop-item-taken-down',
  'cosmetic-shop-item-taken-down',
  'cosmetic-shop-item-refunded',
  'cosmetic-shop-purchase-refunded',
  'cosmetic-shop-item-sold',
  'challenge-starting',
  'new-challenge-from-following',
  'challenge-ending-soon',
  'challenge-results',
  'crucible-ended',
  'crucible-won',
  'crucible-ending-soon',
  'crucible-starting',
  'crucible-results',
  'crucible-entry-submitted',
  'new-order-sanity-warning',
  'new-order-smite-received',
  'new-order-smite-cleansed',
  'new-order-game-over',
  'new-order-templar-promotion',
  'new-order-knight-demoted',
  'new-order-blessed-buzz-granted',
  'new-comic-chapter',
  'new-comic-comment',
  'referral-reward-settled',
  'referral-milestone-hit',
  'referral-token-expiring',
  'text-scan-rating-raised',
  'storyline-title-moderated',
  'creator-score-tier-reached',
  'creator-milestone-reached',
];
