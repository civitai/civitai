import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  serviceDealNotificationTypes,
  type ServiceDealNotice,
  type ServiceDealNotificationDetails,
} from '~/server/notifications/creator-service.notifications';
import { createNotification } from '~/server/services/notification.service';
import type { ServiceDealEventType } from '~/shared/utils/prisma/enums';

type Recipient = 'buyer' | 'seller' | 'otherParty';

const transitionNotices: Partial<
  Record<ServiceDealEventType, { notice: ServiceDealNotice; to: Recipient }>
> = {
  Accepted: { notice: 'accepted', to: 'buyer' },
  Declined: { notice: 'declined', to: 'buyer' },
  Expired: { notice: 'expired', to: 'buyer' },
  Delivered: { notice: 'delivered', to: 'buyer' },
  RevisionRequested: { notice: 'revisionRequested', to: 'seller' },
  CancellationRequested: { notice: 'cancellationRequested', to: 'otherParty' },
  Completed: { notice: 'completed', to: 'seller' },
};

export async function getDealPartiesWithTitle(dealId: number) {
  const [deal] = await dbWrite.$queryRaw<{ buyerId: number; sellerId: number; title: string }[]>`
    SELECT d."buyerId", d."sellerId", o."title"
    FROM "ServiceDeal" d JOIN "ServiceOffering" o ON o."id" = d."offeringId"
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

    const details: ServiceDealNotificationDetails = { dealId, offeringTitle: deal.title };
    let userId = to === 'buyer' ? deal.buyerId : deal.sellerId;
    if (to === 'otherParty') {
      // Only a party has an other party; a system or moderator actor would be misattributed.
      if (actorId === deal.buyerId) details.requestedBy = 'buyer';
      else if (actorId === deal.sellerId) details.requestedBy = 'seller';
      else return;
      userId = details.requestedBy === 'buyer' ? deal.sellerId : deal.buyerId;
    }

    await createNotification({
      userId,
      type,
      category: NotificationCategory.System,
      key: [type, dealId, key].filter((part) => part !== undefined).join(':'),
      details,
    });
  } catch (error) {
    logToAxiom({
      name: 'creator-service-deal',
      type: 'error',
      message: 'deal notification could not be sent',
      dealId,
      notice,
      error: (error as Error)?.message,
    }).catch(() => null);
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
