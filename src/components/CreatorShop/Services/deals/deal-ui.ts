import type { DealAction } from '~/shared/utils/creator-service-deal-view';
import type { ServiceDealStatus } from '~/shared/utils/prisma/enums';

/**
 * Ways out of a deal. These stay usable when `creatorServices` is off, so held Buzz is never
 * trapped. Accepting a delivery finishes the deal, and a dispute is the buyer's only way to stop
 * the release on bad files. A revision asks the seller for new work, so it is an entry.
 */
const EXIT_ACTIONS: readonly DealAction[] = [
  'decline',
  'withdraw',
  'cancelLate',
  'requestCancellation',
  'respondCancellation',
  'acceptDelivery',
  'openDispute',
];

export function visibleDealActions(
  actions: DealAction[],
  { servicesEnabled }: { servicesEnabled: boolean }
) {
  return actions.filter((action) => servicesEnabled || EXIT_ACTIONS.includes(action));
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
  | 'awaitingRelease'
  | 'disputed'
  | 'disputeSettled'
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
  if (!deal.held) return 'confirming';
  if (deal.status === 'Completed') return deal.settled ? 'released' : 'awaitingRelease';
  // Which way a moderator settled it is on the sheet, not in these flags.
  if (deal.status === 'Disputed') return deal.settled ? 'disputeSettled' : 'disputed';
  return 'held';
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
  awaitingRelease: {
    title: 'Held in escrow',
    body: 'The deal is complete. The Buzz is still held, not paid, and is released to the seller when the dispute window closes.',
    color: 'yellow',
  },
  disputed: {
    title: 'Held in escrow',
    body: 'The Buzz stays held while our moderators review this deal. They decide whether it goes to the seller or back to the buyer.',
    color: 'orange',
  },
  disputeSettled: {
    title: 'Settled by moderators',
    body: 'Our moderators resolved this deal. The accountability sheet shows where the Buzz went.',
    color: 'gray',
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

/**
 * The accountability sheet in rounds. An event's round is the deal's `revisionsUsed` when it was
 * written, so round 0 is the original order and round N follows the Nth revision request. Some
 * system events (escrow legs, holds) are written with the column default 0 after a revision, so a
 * round never goes backwards: such an event joins the round in progress.
 */
export function groupEventsByRound<T extends { round: number }>(events: T[]) {
  const groups: { round: number; events: T[] }[] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (last && event.round <= last.round) last.events.push(event);
    else groups.push({ round: event.round, events: [event] });
  }
  return groups;
}

export const roundLabel = (round: number) => (round === 0 ? 'Original order' : `Revision ${round}`);

/**
 * A dispute Civitai opened rather than the buyer: a payout held for moderators, or a final file
 * that failed its check. Its comment is an internal reason code, never shown to either party.
 */
export const isSystemDispute = (event: { type: string; actorRole: string }) =>
  event.type === 'Disputed' && event.actorRole === 'system';

/** Whether the deal's current dispute is a system hold: the latest Disputed event decides. */
export const isModeratorHold = (events: { type: string; actorRole: string }[]) => {
  const latest = events.filter((event) => event.type === 'Disputed').at(-1);
  return !!latest && isSystemDispute(latest);
};
