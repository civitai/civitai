import {
  SERVICE_DEAL_ACCEPT_WINDOW_MS,
  SERVICE_DEAL_AUTO_COMPLETE_MS,
  SERVICE_DEAL_CANCELLATION_RESPONSE_MS,
  SERVICE_DEAL_HOLD_REASONS,
  SERVICE_DEAL_LATE_CANCEL_AFTER_MS,
} from '~/shared/constants/creator-services.constants';
import type { ServiceDealStatus } from '~/shared/utils/prisma/enums';

/**
 * What a viewer may do with a deal right now, and its deadlines, from the deal row alone. The UI
 * renders these and never re-derives the rules; the server's transitions enforce the same rules
 * in SQL, so this decides only which buttons show, never what is allowed.
 */

export type DealAction =
  | 'accept'
  | 'decline'
  | 'withdraw'
  | 'acceptDelivery'
  | 'requestRevision'
  | 'cancelLate'
  | 'requestCancellation'
  | 'respondCancellation'
  | 'openDispute';

export type DealViewerRole = 'buyer' | 'seller' | 'moderator';
export type DealActorRole = 'buyer' | 'seller' | 'system' | 'moderator';

export type DealDeadlineKind =
  | 'acceptBy'
  | 'due'
  | 'autoCompleteAt'
  | 'autoCancelAt'
  | 'disputeUntil';

export type DealTimingFields = {
  status: ServiceDealStatus;
  buyerId: number;
  sellerId: number;
  revisionsUsed: number;
  revisionsIncluded: number;
  requestedAt: Date;
  dueAt: Date | null;
  deliveredAt: Date | null;
  releaseAt: Date | null;
  cancellationRequestedAt: Date | null;
  cancellationRequestedById: number | null;
  heldAt: Date | null;
  settledAt: Date | null;
};

const PRIMARY: DealAction[] = ['accept', 'acceptDelivery', 'respondCancellation', 'cancelLate'];

/**
 * Behind `gated` on the router: the `creatorServices` flag, and `guardedProcedure`, which refuses a
 * muted user. Not offered while either would refuse them.
 */
export const DEAL_GATED_ACTIONS: readonly DealAction[] = ['accept', 'requestRevision'];

const plus = (date: Date | null, ms: number) => (date ? new Date(date.getTime() + ms) : null);

export function dealViewerRole(
  deal: Pick<DealTimingFields, 'buyerId' | 'sellerId'>,
  viewerId: number
) {
  if (viewerId === deal.buyerId) return 'buyer' as const;
  if (viewerId === deal.sellerId) return 'seller' as const;
  return 'moderator' as const;
}

export function dealActorRole(
  deal: Pick<DealTimingFields, 'buyerId' | 'sellerId'>,
  actorId: number
): DealActorRole {
  if (actorId === -1) return 'system';
  if (actorId === deal.buyerId) return 'buyer';
  if (actorId === deal.sellerId) return 'seller';
  return 'moderator';
}

const HOLD_REASONS: readonly string[] = Object.values(SERVICE_DEAL_HOLD_REASONS);

/**
 * A dispute reason or event comment as the viewer may see it. A system hold's reason says the
 * seller was banned or a file failed scanning: moderators see it, the parties never do.
 */
export function dealVisibleReason(reason: string | null, isModerator: boolean): string | null {
  return !isModerator && reason !== null && HOLD_REASONS.includes(reason) ? null : reason;
}

/** An event's actor id as the parties may see it: their own ids only, never a moderator's. */
export function dealEventActorId(
  deal: Pick<DealTimingFields, 'buyerId' | 'sellerId'>,
  actorId: number
): number | null {
  return actorId === deal.buyerId || actorId === deal.sellerId ? actorId : null;
}

export function dealDeadlines(deal: DealTimingFields) {
  // Only before the first delivery: after one, the due date is history.
  const working = deal.status === 'Accepted';
  return {
    acceptBy:
      deal.status === 'Requested' ? plus(deal.requestedAt, SERVICE_DEAL_ACCEPT_WINDOW_MS) : null,
    due: working ? deal.dueAt : null,
    lateCancelFrom: working ? plus(deal.dueAt, SERVICE_DEAL_LATE_CANCEL_AFTER_MS) : null,
    autoCompleteAt:
      deal.status === 'Delivered' ? plus(deal.deliveredAt, SERVICE_DEAL_AUTO_COMPLETE_MS) : null,
    autoCancelAt:
      deal.status === 'CancellationRequested'
        ? plus(deal.cancellationRequestedAt, SERVICE_DEAL_CANCELLATION_RESPONSE_MS)
        : null,
    disputeUntil: deal.status === 'Completed' && !deal.settledAt ? deal.releaseAt : null,
  };
}

export function nextDealDeadline(deal: DealTimingFields) {
  const deadlines = dealDeadlines(deal);
  const kinds: DealDeadlineKind[] = [
    'acceptBy',
    'due',
    'autoCompleteAt',
    'autoCancelAt',
    'disputeUntil',
  ];
  let next: { kind: DealDeadlineKind; at: Date } | null = null;
  for (const kind of kinds) {
    const at = deadlines[kind];
    if (at && (!next || at < next.at)) next = { kind, at };
  }
  return next;
}

/** Ordered by prominence. */
export function dealActions(
  deal: DealTimingFields,
  viewerId: number,
  now = new Date(),
  {
    gatedAllowed = true,
    offeringTakenDown = false,
  }: {
    gatedAllowed?: boolean;
    /** A moderator took the offering down: a pending request can be declined, never accepted. */
    offeringTakenDown?: boolean;
  } = {}
) {
  const role = dealViewerRole(deal, viewerId);
  const actions: DealAction[] = [];
  const answersCancellation =
    deal.status === 'CancellationRequested' && deal.cancellationRequestedById !== viewerId;

  if (role === 'buyer') {
    switch (deal.status) {
      case 'Requested':
        actions.push('withdraw');
        break;
      case 'Accepted':
      case 'InRevision': {
        const lateFrom = dealDeadlines(deal).lateCancelFrom;
        if (lateFrom && lateFrom <= now) actions.push('cancelLate');
        actions.push('requestCancellation');
        break;
      }
      case 'Delivered':
        actions.push('acceptDelivery');
        if (deal.revisionsUsed < deal.revisionsIncluded) actions.push('requestRevision');
        actions.push('requestCancellation');
        break;
      case 'CancellationRequested':
        if (answersCancellation) actions.push('respondCancellation');
        break;
      case 'Completed':
        if (!deal.settledAt && deal.releaseAt && deal.releaseAt > now) actions.push('openDispute');
        break;
    }
  } else if (role === 'seller') {
    switch (deal.status) {
      case 'Requested':
        if (deal.heldAt && !offeringTakenDown) actions.push('accept');
        actions.push('decline');
        break;
      case 'Accepted':
      case 'InRevision':
      case 'Delivered':
        actions.push('requestCancellation');
        break;
      case 'CancellationRequested':
        if (answersCancellation) actions.push('respondCancellation');
        break;
    }
  }

  const offered = gatedAllowed
    ? actions
    : actions.filter((action) => !DEAL_GATED_ACTIONS.includes(action));
  return {
    actions: offered,
    primaryAction: offered.find((action) => PRIMARY.includes(action)) ?? null,
  };
}
