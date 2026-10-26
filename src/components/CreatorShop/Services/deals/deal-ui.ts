import {
  SERVICE_DEAL_CANCELLATION_REASON_CODES,
  SERVICE_DEAL_DECLINE_REASON_CODES,
  SERVICE_DEAL_DISPUTE_REASON_CODES,
} from '~/shared/constants/creator-services.constants';
import type {
  ServiceDealCancellationReasonCode,
  ServiceDealReasonCode,
} from '~/shared/constants/creator-services.constants';
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

/** Whether the deal is waiting on the viewer: it has a primary button they can see. */
export const awaitsViewer = (
  deal: { actions: DealAction[]; primaryAction: DealAction | null },
  { servicesEnabled }: { servicesEnabled: boolean }
) => dealButtons(deal, { servicesEnabled }).some((button) => button.primary);

/** The request toast. Only a confirmed hold may be called held. */
export const requestSentMessage = (held: boolean) =>
  held
    ? 'Your Buzz is held until the deal completes.'
    : "We're confirming your payment; the seller can accept once it's confirmed.";

export type DealPageState =
  | { kind: 'loading' }
  | { kind: 'notFound' }
  | { kind: 'error' }
  | { kind: 'deal' };

/**
 * How the server refuses a deal: as missing, so a non-party learns nothing about it. A session
 * that ended mid-view is refused before any lookup, and trying again cannot help it.
 */
const REFUSED = ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'];

/** The deal query's failure as `dealPageState` reads it: the tRPC code the server sent, if any. */
export const dealQueryError = (error: { data?: { code?: string } | null } | null | undefined) =>
  error ? { code: error.data?.code } : null;

/**
 * The deal page renders for whoever the server returns the deal to (buyer, seller, moderator),
 * flag on or off; anyone else gets NotFound. Any other failure, a server error or a dropped
 * connection, is an error the viewer can retry: a party must never be told their deal is gone.
 */
export function dealPageState({
  isLoading,
  hasDeal,
  error,
}: {
  isLoading: boolean;
  hasDeal: boolean;
  /** The query's failure, if any; `code` is the server's tRPC error code when it sent one. */
  error?: { code?: string } | null;
}): DealPageState {
  if (isLoading) return { kind: 'loading' };
  if (hasDeal) return { kind: 'deal' };
  if (error && !REFUSED.includes(error.code ?? '')) return { kind: 'error' };
  return { kind: 'notFound' };
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

type SheetEvent = { type: string; actorRole: string; comment: string | null };

/**
 * A dispute Civitai opened rather than the buyer: a payout held for moderators, or a final file
 * that failed its check. Its comment is an internal reason code for moderators: the sheet never
 * shows it to a party, whatever the response carries.
 */
export const isSystemDispute = (event: { type: string; actorRole: string }) =>
  event.type === 'Disputed' && event.actorRole === 'system';

/** Events that move a deal into Disputed. A refused cancellation escalates too. */
const DISPUTE_OPENERS = ['Disputed', 'CancellationDeclined'];

/** Whether the deal's current dispute is a system hold: the latest event that opened one decides. */
export const isModeratorHold = (events: { type: string; actorRole: string }[]) => {
  const latest = events.filter((event) => DISPUTE_OPENERS.includes(event.type)).at(-1);
  return !!latest && isSystemDispute(latest);
};

/** What the accountability sheet prints for one event. */
export function sheetEventText<T extends SheetEvent>(
  event: T,
  viewerRole: 'buyer' | 'seller' | 'moderator',
  label: string
) {
  if (!isSystemDispute(event)) return { label, comment: event.comment };
  return {
    label: 'Held the deal for moderator review',
    comment: viewerRole === 'moderator' ? event.comment : null,
  };
}

/** The notice on a Disputed deal; none once it has settled, when the Buzz is no longer held. */
export function disputeNotice(deal: {
  status: ServiceDealStatus;
  settled: boolean;
  events: { type: string; actorRole: string }[];
}) {
  if (deal.status !== 'Disputed' || deal.settled) return null;
  return isModeratorHold(deal.events)
    ? 'This deal is held for moderator review. The Buzz stays held until they resolve it.'
    : 'This deal is in dispute and with our moderators. The Buzz stays held until they resolve it.';
}

export const reasonCodeLabel: Record<ServiceDealReasonCode, string> = {
  too_busy: 'Too busy right now',
  out_of_scope: 'Outside what I offer',
  price_or_terms: 'Price or terms',
  not_delivered: 'Not delivered',
  quality: 'Quality problems',
  changed_mind: 'Changed my mind',
  buyer_unresponsive: 'Buyer not responding',
  cannot_complete: "Can't complete it",
  files_missing_or_broken: 'Files missing or broken',
  not_as_previewed: 'Not what the preview showed',
  other: 'Other',
};

const codeOptions = (codes: readonly ServiceDealReasonCode[]) =>
  codes.map((value) => ({ value, label: reasonCodeLabel[value] }));

export const declineCodeOptions = codeOptions(SERVICE_DEAL_DECLINE_REASON_CODES);
export const disputeCodeOptions = codeOptions(SERVICE_DEAL_DISPUTE_REASON_CODES);

/**
 * Cancellation reasons offered to each side. The server takes any of them from either party;
 * the picker shows the ones that party could mean, so a seller is never offered "Changed my mind".
 */
const CANCELLATION_CODES_BY_ROLE: Record<'buyer' | 'seller', ServiceDealCancellationReasonCode[]> =
  {
    buyer: ['not_delivered', 'quality', 'changed_mind', 'other'],
    seller: ['buyer_unresponsive', 'cannot_complete', 'other'],
  };

export const cancellationCodeOptions = (role: 'buyer' | 'seller') =>
  codeOptions(
    SERVICE_DEAL_CANCELLATION_REASON_CODES.filter((code) =>
      CANCELLATION_CODES_BY_ROLE[role].includes(code)
    )
  );

/**
 * What a reason form sends. A muted viewer's text is never sent: the server would drop it, and the
 * form never shows them a box. Empty values are left out rather than sent as "".
 */
export function reasonFormValues({
  muted,
  text,
  code,
}: {
  muted: boolean;
  text: string;
  code: string | null;
}) {
  const trimmed = muted ? '' : text.trim();
  return { text: trimmed || undefined, code: code ?? undefined };
}

/**
 * How a reason form marks what it needs. An asterisk goes on a field only when it is the one way
 * to meet the requirement: the picker for a muted viewer (no text box), the text box when there
 * is no picker. With both, either meets it, so neither is starred and the hint says so.
 */
export function reasonFormLabels({
  required,
  hasCodes,
  muted,
}: {
  required: boolean;
  hasCodes: boolean;
  muted: boolean;
}) {
  return {
    codeRequired: required && hasCodes && muted,
    codeClearable: !(required && hasCodes && muted),
    textRequired: required && !hasCodes,
    textLabel: !required
      ? 'Comment (optional)'
      : hasCodes
      ? 'Details (optional if you picked a reason)'
      : 'Reason',
    hint: required && hasCodes && !muted ? 'Pick a reason, add details, or both.' : undefined,
  };
}

/** A reason form can be sent when nothing is required, or the text or a picked code gives one. */
export function textActionReady({
  required,
  text,
  code,
  hasCodes,
}: {
  required: boolean;
  text: string;
  code: string | null;
  hasCodes: boolean;
}) {
  if (!required) return true;
  return !!text || (hasCodes && !!code);
}

/** The label for a stored reason code, or null for none or one this client doesn't know. */
export const reasonLabel = (code: string | null | undefined) =>
  code && Object.hasOwn(reasonCodeLabel, code)
    ? reasonCodeLabel[code as ServiceDealReasonCode]
    : null;

/**
 * What the other side gave as their reason for asking to cancel: the code of the latest request
 * and its text, either of which may be missing (a muted party has no text).
 */
export function cancellationReasonLine(deal: {
  cancellation: { reason: string | null } | null;
  events: { type: string; reasonCode: string | null }[];
}) {
  const latest = deal.events.filter((event) => event.type === 'CancellationRequested').at(-1);
  const code = reasonLabel(latest?.reasonCode);
  const text = deal.cancellation?.reason;
  if (code && text) return `Their reason: ${code}. "${text}"`;
  if (code) return `Their reason: ${code}.`;
  if (text) return `Their reason: "${text}"`;
  return undefined;
}

const inList = <T extends string>(list: readonly T[], code: string | undefined) =>
  code !== undefined && (list as readonly string[]).includes(code) ? (code as T) : undefined;

/**
 * The inputs each exit sends. A code is sent only if it belongs to that action's list, so a code
 * picked for one action can never reach another's schema.
 */
export const exitInputs = {
  decline: (id: number, text: string | undefined, code: string | undefined) => ({
    id,
    reason: text,
    reasonCode: inList(SERVICE_DEAL_DECLINE_REASON_CODES, code),
  }),
  requestCancellation: (id: number, text: string | undefined, code: string | undefined) => ({
    id,
    reason: text,
    reasonCode: inList(SERVICE_DEAL_CANCELLATION_REASON_CODES, code),
  }),
  openDispute: (id: number, text: string | undefined, code: string | undefined) => ({
    id,
    reason: text,
    reasonCode: inList(SERVICE_DEAL_DISPUTE_REASON_CODES, code),
  }),
};

/** Which side's cancellation reasons a viewer is offered. */
export const cancellationSide = (viewerRole: 'buyer' | 'seller' | 'moderator') =>
  viewerRole === 'seller' ? ('seller' as const) : ('buyer' as const);

/**
 * A seller's open deals on one offering, for their own storefront card. One deal opens straight
 * to it; several open the list. `complete` is false when the list holds open deals that were not
 * loaded (a later page, or mature deals left out on this domain): the count is then a floor, the
 * card never jumps to one deal, and it still offers the list, since this offering may have deals
 * among the unloaded ones.
 */
export function openDealsOnOffering(
  deals: { id: number; offering: { id: number } }[],
  offeringId: number,
  complete: boolean
): { label: string; dealId?: number } | undefined {
  const onOffering = deals.filter((deal) => deal.offering.id === offeringId);
  if (complete)
    return onOffering.length === 0
      ? undefined
      : {
          label: `Open deal (${onOffering.length})`,
          dealId: onOffering.length === 1 ? onOffering[0].id : undefined,
        };
  return { label: onOffering.length ? `Open deal (${onOffering.length}+)` : 'Open deals' };
}
