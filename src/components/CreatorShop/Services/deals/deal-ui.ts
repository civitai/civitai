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

/** The buttons the deal page shows, in order. The primary is dropped if the filter removed it. */
export function dealButtons(
  deal: { actions: DealAction[]; primaryAction: DealAction | null },
  { servicesEnabled }: { servicesEnabled: boolean }
) {
  const actions = visibleDealActions(deal.actions, { servicesEnabled });
  const primary =
    deal.primaryAction && actions.includes(deal.primaryAction) ? deal.primaryAction : null;
  const ordered = primary ? [primary, ...actions.filter((a) => a !== primary)] : actions;
  return ordered.map((action) => ({ action, primary: action === primary }));
}

/** The request toast. Only a confirmed hold may be called held. */
export const requestSentMessage = (held: boolean) =>
  held
    ? 'Your Buzz is held until the deal completes.'
    : "We're confirming your payment; the seller can accept once it's confirmed.";

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

export type EscrowState =
  | 'confirming'
  | 'held'
  | 'closedUncharged'
  | 'refundPending'
  | 'refunded'
  | 'released';

const REFUND_STATUSES: ServiceDealStatus[] = ['Declined', 'Expired', 'Cancelled'];

/**
 * Never says "held" until the hold is confirmed. A closed deal whose hold never confirmed took no
 * Buzz; the server still looks for a charge that lands late and returns it.
 */
export function dealEscrowState(deal: {
  status: ServiceDealStatus;
  held: boolean;
  settled: boolean;
}): EscrowState {
  if (REFUND_STATUSES.includes(deal.status)) {
    if (deal.settled) return 'refunded';
    return deal.held ? 'refundPending' : 'closedUncharged';
  }
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
  closedUncharged: {
    title: 'Closed, nothing charged',
    body: 'This deal closed before the payment was confirmed, so no Buzz was taken. If a charge turns up late, it is returned automatically.',
    color: 'gray',
  },
  refundPending: {
    title: 'Refund on its way',
    body: 'This deal closed without completing. The Buzz held for it is being returned to the buyer.',
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
