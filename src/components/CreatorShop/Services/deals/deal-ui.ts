import type { DealAction } from '~/shared/utils/creator-service-deal-view';
import type { ServiceDealStatus } from '~/shared/utils/prisma/enums';

/** The actions this phase renders. Delivery, acceptance and disputes arrive with file delivery. */
const P2_ACTIONS: readonly DealAction[] = [
  'accept',
  'decline',
  'withdraw',
  'cancelLate',
  'requestCancellation',
  'respondCancellation',
];

/** Ways out of a deal. These stay usable when `creatorServices` is off, so held Buzz is never trapped. */
const EXIT_ACTIONS: readonly DealAction[] = [
  'decline',
  'withdraw',
  'cancelLate',
  'requestCancellation',
  'respondCancellation',
];

export function visibleDealActions(
  actions: DealAction[],
  { servicesEnabled }: { servicesEnabled: boolean }
) {
  return actions.filter(
    (action) => P2_ACTIONS.includes(action) && (servicesEnabled || EXIT_ACTIONS.includes(action))
  );
}

export type DealPageState = { kind: 'loading' } | { kind: 'notFound' } | { kind: 'deal' };

/**
 * The deal page renders for whoever the server returns the deal to (buyer, seller, moderator),
 * flag on or off; anyone else, or any error, gets NotFound.
 */
export function dealPageState({
  isLoading,
  hasDeal,
}: {
  isLoading: boolean;
  hasDeal: boolean;
}): DealPageState {
  if (isLoading) return { kind: 'loading' };
  return hasDeal ? { kind: 'deal' } : { kind: 'notFound' };
}

export type EscrowState = 'confirming' | 'held' | 'refundPending' | 'refunded' | 'released';

const REFUND_STATUSES: ServiceDealStatus[] = ['Declined', 'Expired', 'Cancelled'];

/**
 * Never says "held" until the hold is confirmed. A refund-bound deal whose hold never confirmed
 * is still "refund pending": a charge that lands late is found and returned.
 */
export function dealEscrowState(deal: {
  status: ServiceDealStatus;
  held: boolean;
  settled: boolean;
}): EscrowState {
  if (REFUND_STATUSES.includes(deal.status)) return deal.settled ? 'refunded' : 'refundPending';
  if (deal.status === 'Completed') return deal.settled ? 'released' : 'held';
  return deal.held ? 'held' : 'confirming';
}

export const escrowCopy: Record<EscrowState, { title: string; body: string; color: string }> = {
  confirming: {
    title: 'Confirming payment',
    body: 'We are confirming the Buzz for this request. The seller can accept once it is confirmed, usually within a few minutes.',
    color: 'gray',
  },
  held: {
    title: 'Held in escrow',
    body: 'The Buzz is held, not paid. Nothing moves until the deal completes or is cancelled.',
    color: 'yellow',
  },
  refundPending: {
    title: 'Refund on its way',
    body: 'This deal closed without completing. Any Buzz taken for it is being returned to the buyer.',
    color: 'red',
  },
  refunded: {
    title: 'Refunded',
    body: 'The Buzz has been returned to the buyer.',
    color: 'red',
  },
  released: {
    title: 'Released',
    body: 'The Buzz has been paid to the seller.',
    color: 'green',
  },
};

export const dealStatusLabel: Record<ServiceDealStatus, string> = {
  Requested: 'Awaiting seller',
  Accepted: 'In progress',
  Delivered: 'Delivered',
  InRevision: 'Revision requested',
  Completed: 'Complete',
  Declined: 'Declined',
  Expired: 'Expired',
  CancellationRequested: 'Cancellation requested',
  Cancelled: 'Cancelled',
  Disputed: 'In dispute',
};

export const dealActionLabel: Record<DealAction, string> = {
  accept: 'Accept request',
  decline: 'Decline',
  withdraw: 'Withdraw request',
  cancelLate: 'Cancel (overdue)',
  requestCancellation: 'Request cancellation',
  respondCancellation: 'Respond to cancellation',
  acceptDelivery: 'Accept delivery',
  requestRevision: 'Request a revision',
  openDispute: 'Report a problem',
};
