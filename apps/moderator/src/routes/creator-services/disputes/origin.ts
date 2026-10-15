import type { DisputeEvent, DisputeRow } from '$lib/server/creator-services-disputes.service';

const SYSTEM_LABELS: Record<string, string> = {
  seller_unavailable: 'Seller banned or deleted before payout',
  final_scan_failed: 'A final file failed scanning',
};

/**
 * Where a dispute came from. `disputeReason` is one of two system codes, `cancellation_declined`, or the
 * buyer's own free text — so anything unrecognised is the buyer's words and is shown as text, never
 * guessed into a label.
 */
export function disputeOrigin(
  row: Pick<DisputeRow, 'disputeReason' | 'cancellationReason'> & { events?: DisputeEvent[] }
): {
  label: string;
  system: boolean;
  text: string | null;
  /** The party's chosen code, only when their text is absent (muted, or a code-only reason). */
  code: string | null;
} {
  const reason = row.disputeReason;
  if (reason && Object.hasOwn(SYSTEM_LABELS, reason))
    return { label: SYSTEM_LABELS[reason], system: true, text: null, code: null };

  const declined = reason === 'cancellation_declined';
  const text = declined ? row.cancellationReason : reason;
  const code = text
    ? null
    : latestReasonCode(row.events, declined ? 'CancellationRequested' : 'Disputed');
  return {
    label: declined ? 'Cancellation declined' : 'Buyer dispute',
    system: false,
    text,
    code,
  };
}

// Filtered by type, not "latest with a code": which events carry a party's code is a property of the
// state machine today, not a rule. A party dispute is the `Disputed` event a party (not the system)
// wrote; a declined cancellation's code is on the request, never on the decline.
function latestReasonCode(
  events: DisputeEvent[] = [],
  type: 'Disputed' | 'CancellationRequested'
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === type && e.actorId !== -1 && e.reasonCode) return e.reasonCode;
  }
  return null;
}
