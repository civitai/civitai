/**
 * App Store Listings (W13) — P3a off-site submission status → chip mapping
 * (PURE view-model). The `AppListingPublishRequest.status` domain is
 * `pending | approved | rejected | withdrawn` (mirrors the on-site request
 * state machine). Extracted so the my-submissions status chip is unit-testable
 * for all four states (plus an unknown-status fallback) without mounting the list.
 */

export type OffsiteSubmissionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export type OffsiteStatusChip = {
  /** Mantine color token. */
  color: string;
  /** Human label shown in the badge. */
  label: string;
};

const STATUS_CHIPS: Record<OffsiteSubmissionStatus, OffsiteStatusChip> = {
  pending: { color: 'blue', label: 'pending' },
  approved: { color: 'green', label: 'approved' },
  rejected: { color: 'red', label: 'rejected' },
  withdrawn: { color: 'gray', label: 'withdrawn' },
};

/**
 * Map a request status to its badge descriptor. An unrecognised status falls back
 * to a neutral gray chip showing the raw value (never throws) so a future status
 * value degrades gracefully instead of crashing the row.
 */
export function offsiteStatusChip(status: string): OffsiteStatusChip {
  return STATUS_CHIPS[status as OffsiteSubmissionStatus] ?? { color: 'gray', label: status };
}

/** True for a status the author can still withdraw (only `pending`). */
export function isWithdrawableOffsiteStatus(status: string): boolean {
  return status === 'pending';
}

/**
 * True for a REQUEST status whose backing listing is still editable WITHOUT
 * withdrawing it. `pending` (the listing is a live draft under review — edited in
 * place) and `approved` (the listing is live — a trivial edit applies in place, a
 * material edit is staged as a shadow revision). `rejected`/`withdrawn` deleted
 * their listing (→ resubmit), so they are NOT editable here.
 */
export function isEditableOffsiteStatus(status: string): boolean {
  return status === 'pending' || status === 'approved';
}
