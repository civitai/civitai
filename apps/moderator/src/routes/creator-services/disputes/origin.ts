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

  const text = reason === 'cancellation_declined' ? row.cancellationReason : reason;
  const code = text ? null : latestReasonCode(row.events);
  return {
    label: reason === 'cancellation_declined' ? 'Cancellation declined' : 'Buyer dispute',
    system: false,
    text,
    code,
  };
}

function latestReasonCode(events: DisputeEvent[] = []): string | null {
  for (let i = events.length - 1; i >= 0; i--)
    if (events[i].reasonCode) return events[i].reasonCode ?? null;
  return null;
}
