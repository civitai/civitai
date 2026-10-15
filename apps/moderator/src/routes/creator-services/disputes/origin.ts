import type { DisputeRow } from '$lib/server/creator-services-disputes.service';

const SYSTEM_LABELS: Record<string, string> = {
  seller_unavailable: 'Seller banned or deleted before payout',
  final_scan_failed: 'A final file failed scanning',
};

/**
 * Where a dispute came from. `disputeReason` is one of two system codes, `cancellation_declined`, or the
 * buyer's own free text — so anything unrecognised is the buyer's words and is shown as text, never
 * guessed into a label.
 */
export function disputeOrigin(row: Pick<DisputeRow, 'disputeReason' | 'cancellationReason'>): {
  label: string;
  system: boolean;
  text: string | null;
} {
  const reason = row.disputeReason;
  if (reason && Object.hasOwn(SYSTEM_LABELS, reason))
    return { label: SYSTEM_LABELS[reason], system: true, text: null };
  if (reason === 'cancellation_declined')
    return { label: 'Cancellation declined', system: false, text: row.cancellationReason };
  return { label: 'Buyer dispute', system: false, text: reason };
}
