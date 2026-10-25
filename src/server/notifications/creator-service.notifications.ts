import { SERVICE_OFFERING_TAKEN_DOWN } from '@civitai/shared/service-offering-takedown';
import { NotificationCategory } from '~/server/common/enums';
import { getServiceOfferingTakedownReason } from '~/server/common/moderation-helpers';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import type { NotificationProcessor } from '~/server/notifications/base.notifications';

export const serviceDealNotificationTypes = {
  requested: 'service-deal-requested',
  accepted: 'service-deal-accepted',
  declined: 'service-deal-declined',
  expired: 'service-deal-expired',
  delivered: 'service-deal-delivered',
  revisionRequested: 'service-deal-revision-requested',
  cancellationRequested: 'service-deal-cancellation-requested',
  completed: 'service-deal-completed',
  paidOut: 'service-deal-paid-out',
} as const;
export type ServiceDealNotice = keyof typeof serviceDealNotificationTypes;

export type ServiceDealNotificationDetails = {
  dealId: number;
  offeringTitle: string;
  /** Who asked, for a cancellation request. */
  requestedBy?: 'buyer' | 'seller';
};

const dealNotification = (
  displayName: string,
  message: (details: ServiceDealNotificationDetails) => string
): NotificationProcessor => ({
  displayName,
  category: NotificationCategory.System,
  defaultPush: true,
  defaultEmail: true,
  prepareMessage: ({ details }) => {
    if (!details?.dealId) return undefined;
    return {
      message: message(details as ServiceDealNotificationDetails),
      url: `/services/deals/${details.dealId}`,
    };
  },
});

export const creatorServiceNotifications = createNotificationProcessor({
  // Sent once to the seller when a moderator takes their offering down. Never names the moderator.
  [SERVICE_OFFERING_TAKEN_DOWN]: {
    displayName: 'Service taken down',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      if (!details) return undefined;
      const reasonCopy =
        details.reason === 'other'
          ? details.details
          : getServiceOfferingTakedownReason(details.reason)?.notificationMessage;
      const service = `Your service "${details.offeringTitle}" has been removed by a moderator`;
      return {
        message: reasonCopy ? `${service}: ${reasonCopy}` : `${service}.`,
        url: details.sellerUsername ? `/user/${details.sellerUsername}/shop/manage` : undefined,
      };
    },
  },
  [serviceDealNotificationTypes.requested]: dealNotification(
    'Services: New request for your service',
    ({ offeringTitle }) =>
      `You have a new request for "${offeringTitle}". Accept or decline it before it expires.`
  ),
  [serviceDealNotificationTypes.accepted]: dealNotification(
    'Services: Your request was accepted',
    ({ offeringTitle }) => `Your request for "${offeringTitle}" was accepted.`
  ),
  [serviceDealNotificationTypes.declined]: dealNotification(
    'Services: Your request was declined',
    ({ offeringTitle }) =>
      `Your request for "${offeringTitle}" was declined. The Buzz held for it is being returned.`
  ),
  [serviceDealNotificationTypes.expired]: dealNotification(
    'Services: Your request expired',
    ({ offeringTitle }) =>
      `Your request for "${offeringTitle}" expired without an answer. The Buzz held for it is being returned.`
  ),
  [serviceDealNotificationTypes.delivered]: dealNotification(
    'Services: Your order was delivered',
    ({ offeringTitle }) => `Your order for "${offeringTitle}" was delivered. Review it.`
  ),
  [serviceDealNotificationTypes.revisionRequested]: dealNotification(
    'Services: A buyer requested a revision',
    ({ offeringTitle }) => `The buyer asked for a revision of "${offeringTitle}".`
  ),
  [serviceDealNotificationTypes.cancellationRequested]: dealNotification(
    'Services: Cancellation requested',
    ({ offeringTitle, requestedBy }) =>
      `The ${
        requestedBy ?? 'other party'
      } asked to cancel the deal for "${offeringTitle}". Respond before it cancels on its own.`
  ),
  [serviceDealNotificationTypes.completed]: dealNotification(
    'Services: Your deal was completed',
    ({ offeringTitle }) =>
      `Your deal for "${offeringTitle}" is complete. You are paid once the dispute window closes.`
  ),
  [serviceDealNotificationTypes.paidOut]: dealNotification(
    'Services: You were paid for a deal',
    ({ offeringTitle }) => `Your Buzz for "${offeringTitle}" has been paid out.`
  ),
});
