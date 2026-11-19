import { SERVICE_OFFERING_TAKEN_DOWN } from '@civitai/shared/service-offering-takedown';
import { NotificationCategory } from '~/server/common/enums';
import { getServiceOfferingTakedownReason } from '~/server/common/moderation-helpers';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import type { NotificationProcessor } from '~/server/notifications/base.notifications';
import {
  SERVICE_DEAL_AUTO_COMPLETE_NOTICE_MS,
  SERVICE_DEAL_CLOSE_LABELS,
  SERVICE_DEAL_DUE_SOON_NOTICE_MS,
  SERVICE_DEAL_OVERDUE_CANCEL_AFTER_MS,
} from '~/shared/constants/creator-services.constants';

const DAY = 24 * 60 * 60 * 1000;
const hours = (value: number) => value / (60 * 60 * 1000);

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
  disputed: 'service-deal-disputed',
  disputeResolved: 'service-deal-dispute-resolved',
  cancellationAccepted: 'service-deal-cancellation-accepted',
  cancellationDeclined: 'service-deal-cancellation-declined',
  cancelled: 'service-deal-cancelled',
  autoCompleteSoon: 'service-deal-auto-complete-soon',
  dueSoon: 'service-deal-due-soon',
  overdue: 'service-deal-overdue',
} as const;
export type ServiceDealNotice = keyof typeof serviceDealNotificationTypes;

export type ServiceDealNotificationDetails = {
  dealId: number;
  offeringTitle: string;
  /** The party who moved the deal, when a party did. */
  requestedBy?: 'buyer' | 'seller';
  /** How moderators settled a dispute. */
  resolution?: 'Release' | 'Refund';
  /** Why a deal closed, as the code the server wrote. */
  closeReason?: string;
  /** The recipient is the buyer and the held Buzz goes back to them. */
  buzzReturned?: boolean;
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
  [serviceDealNotificationTypes.disputed]: dealNotification(
    'Services: A deal was disputed',
    ({ offeringTitle, requestedBy }) =>
      `The ${
        requestedBy ?? 'other party'
      } opened a dispute on the deal for "${offeringTitle}". Moderators will review it.`
  ),
  [serviceDealNotificationTypes.disputeResolved]: dealNotification(
    'Services: A dispute was resolved',
    ({ offeringTitle, resolution }) =>
      `Moderators resolved the dispute on the deal for "${offeringTitle}". ${
        resolution === 'Release'
          ? 'The Buzz goes to the seller.'
          : 'The Buzz goes back to the buyer.'
      }`
  ),
  [serviceDealNotificationTypes.cancellationAccepted]: dealNotification(
    'Services: Your cancellation was accepted',
    ({ offeringTitle, requestedBy }) =>
      `The ${
        requestedBy ?? 'other party'
      } agreed to cancel the deal for "${offeringTitle}". The buyer's Buzz is being returned.`
  ),
  [serviceDealNotificationTypes.cancellationDeclined]: dealNotification(
    'Services: Your cancellation was declined',
    ({ offeringTitle, requestedBy }) =>
      `The ${
        requestedBy ?? 'other party'
      } declined to cancel the deal for "${offeringTitle}". Moderators will review it.`
  ),
  [serviceDealNotificationTypes.cancelled]: dealNotification(
    'Services: A deal was canceled',
    ({ offeringTitle, requestedBy, closeReason, buzzReturned }) => {
      const what = requestedBy
        ? `The ${requestedBy} canceled the deal for "${offeringTitle}".`
        : `"${offeringTitle}": ${
            (closeReason && SERVICE_DEAL_CLOSE_LABELS[closeReason]) || 'Canceled'
          }.`;
      return buzzReturned ? `${what} Your Buzz is being returned.` : what;
    }
  ),
  [serviceDealNotificationTypes.autoCompleteSoon]: dealNotification(
    'Services: Your order completes soon',
    ({ offeringTitle }) =>
      `Your order for "${offeringTitle}" completes on its own in ${hours(
        SERVICE_DEAL_AUTO_COMPLETE_NOTICE_MS
      )} hours. Review it or ask for a revision before then.`
  ),
  [serviceDealNotificationTypes.dueSoon]: dealNotification(
    'Services: A deal is due soon',
    ({ offeringTitle }) =>
      `Your deal for "${offeringTitle}" is due in ${hours(SERVICE_DEAL_DUE_SOON_NOTICE_MS)} hours.`
  ),
  [serviceDealNotificationTypes.overdue]: dealNotification(
    'Services: A deal is past due',
    ({ offeringTitle }) =>
      `Your deal for "${offeringTitle}" is past due. Deliver it, or it cancels and refunds the buyer in ${
        SERVICE_DEAL_OVERDUE_CANCEL_AFTER_MS / DAY
      } days.`
  ),
});
