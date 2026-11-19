import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  serviceDealNotificationTypes,
  type ServiceDealNotice,
  type ServiceDealNotificationDetails,
} from '~/server/notifications/creator-service.notifications';
import { createNotification } from '~/server/services/notification.service';
import {
  ServiceOfferingIngestionStatus,
  type ServiceDealEventType,
} from '~/shared/utils/prisma/enums';

export const HELD_OFFERING_TITLE = 'Service under review';

/** A deal's offering title for anyone but its seller and moderators: the live text only once its content check passed. */
export const counterpartyOfferingTitle = (offering: {
  title: string;
  ingestion: ServiceOfferingIngestionStatus;
}) =>
  offering.ingestion === ServiceOfferingIngestionStatus.Scanned
    ? offering.title
    : HELD_OFFERING_TITLE;

/** 'parties': both buyer and seller, except whichever of them moved the deal. */
type Recipient = 'buyer' | 'seller' | 'otherParty' | 'parties';

const transitionNotices: Partial<
  Record<ServiceDealEventType, { notice: ServiceDealNotice; to: Recipient }>
> = {
  Accepted: { notice: 'accepted', to: 'buyer' },
  Declined: { notice: 'declined', to: 'buyer' },
  Expired: { notice: 'expired', to: 'buyer' },
  Delivered: { notice: 'delivered', to: 'buyer' },
  RevisionRequested: { notice: 'revisionRequested', to: 'seller' },
  CancellationRequested: { notice: 'cancellationRequested', to: 'otherParty' },
  CancellationAccepted: { notice: 'cancellationAccepted', to: 'otherParty' },
  CancellationDeclined: { notice: 'cancellationDeclined', to: 'otherParty' },
  Cancelled: { notice: 'cancelled', to: 'otherParty' },
  Disputed: { notice: 'disputed', to: 'parties' },
  Completed: { notice: 'completed', to: 'seller' },
};

export async function getDealPartiesWithTitle(dealId: number) {
  const [deal] = await dbWrite.$queryRaw<
    {
      buyerId: number;
      sellerId: number;
      title: string;
      ingestion: ServiceOfferingIngestionStatus;
      sellerName: string | null;
      resolution: ServiceDealNotificationDetails['resolution'] | null;
    }[]
  >`
    SELECT d."buyerId", d."sellerId", o."title", o."ingestion"::text AS "ingestion",
      s."username" AS "sellerName", d."disputeResolution"::text AS "resolution"
    FROM "ServiceDeal" d JOIN "ServiceOffering" o ON o."id" = d."offeringId"
    LEFT JOIN "User" s ON s."id" = d."sellerId"
    WHERE d."id" = ${dealId}::int`;
  return deal;
}

/**
 * Tells the other party a deal moved. Call only after the move committed. Never throws: the move
 * stands whether or not the notification goes out.
 */
export async function notifyServiceDeal({
  dealId,
  notice,
  to,
  actorId,
  key,
}: {
  dealId: number;
  notice: ServiceDealNotice;
  to: Recipient;
  actorId?: number;
  /** Distinguishes repeats of the same notice on one deal (a second delivery). */
  key?: string | number;
}) {
  const type = serviceDealNotificationTypes[notice];
  try {
    const deal = await getDealPartiesWithTitle(dealId);
    if (!deal) return;

    const requestedBy =
      actorId === deal.buyerId ? 'buyer' : actorId === deal.sellerId ? 'seller' : undefined;
    let userIds: number[];
    if (to === 'otherParty') {
      // Only a party has an other party; a system or moderator actor would be misattributed.
      if (!requestedBy) return;
      userIds = [requestedBy === 'buyer' ? deal.sellerId : deal.buyerId];
    } else if (to === 'parties') {
      userIds = [deal.buyerId, deal.sellerId].filter((id) => id !== actorId);
    } else userIds = [to === 'buyer' ? deal.buyerId : deal.sellerId];

    for (const userId of userIds) {
      const details: ServiceDealNotificationDetails = {
        dealId,
        offeringTitle: userId === deal.sellerId ? deal.title : counterpartyOfferingTitle(deal),
      };
      if (requestedBy) details.requestedBy = requestedBy;
      if (notice === 'disputeResolved' && deal.resolution) details.resolution = deal.resolution;
      await createNotification({
        userId,
        type,
        category: NotificationCategory.System,
        // One key per recipient where two are told, so neither notification replaces the other.
        key: [type, dealId, key, to === 'parties' ? userId : undefined]
          .filter((part) => part !== undefined)
          .join(':'),
        details,
      });
    }
  } catch (error) {
    logToAxiom({
      name: 'creator-service-deal',
      type: 'error',
      message: 'deal notification could not be sent',
      dealId,
      notice,
      error: (error as Error)?.message,
    });
  }
}

/** The notification a committed transition sends, keyed to its event row so each fires once. */
export const notifyServiceDealTransition = ({
  dealId,
  event,
  eventId,
  actorId,
}: {
  dealId: number;
  event: ServiceDealEventType;
  eventId: number;
  actorId: number;
}) => {
  const target = transitionNotices[event];
  if (!target) return;
  return notifyServiceDeal({ dealId, ...target, actorId, key: eventId });
};
