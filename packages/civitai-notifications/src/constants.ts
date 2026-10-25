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
 * The notification types that send email: exactly the processors with `defaultEmail` in the main
 * app's registry (a main-app test pins the two together). The fan-out worker has no registry, so
 * it reads this list to skip every other type without a call.
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
