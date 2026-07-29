/**
 * App Store Listings (W13) — P3b PR3 MODERATION VIEW MODEL (pure, React-free).
 *
 * The report-row → action-set + status → chip logic for the mod report queue +
 * the per-listing moderation-history view, extracted so the correctness gate lives
 * in the node `unit` project (the civitai browser-mode component suites are
 * REPORT-ONLY / non-blocking — so the real, blocking coverage for this logic lives
 * here, mirroring `appListingReportView` / `appListingCardView`).
 *
 * No React, no Mantine imports — the color strings are plain Mantine color names
 * the component maps onto <Badge color=…>. This keeps the module pure + trivially
 * unit-testable.
 */

/** The mod actions a report row can offer (a subset renders per row). */
export type ReportRowAction = 'delist' | 'relist' | 'claim' | 'purge' | 'resolve' | 'dismiss';

/** A pill descriptor: a human label + a Mantine color name. */
export type Chip = { label: string; color: string };

/**
 * The ordered set of actions to render for a report row, given the report's own
 * status AND its target listing's status.
 *
 *   - resolve / dismiss: only while the report is `pending` (a closed report can't
 *     be re-closed).
 *   - delist: only while the listing is `approved` (delist is approved→removed).
 *   - relist: only while the listing is `removed` (relist is removed→approved).
 *   - claim: on either a live (`approved`) OR a delisted (`removed`) listing — a
 *     mod-verified owner may reclaim either. The report queue only lists OFF-SITE
 *     reports (the report table is offsite-only), so the service's kind guard is
 *     implicitly satisfied here (no kind input needed at the view-model layer).
 *   - purge: only once the listing is `removed` — a mod delists first, THEN purges;
 *     this keeps the destructive hard-delete off a still-live approved listing in
 *     the queue UI (the service itself allows purge on any status, but the queue
 *     nudges the delist→purge order).
 *
 * `listingStatus` may be null (the listing was purged out from under an
 * already-closed report — defensive; cascade normally removes the report) → no
 * listing-level actions.
 */
export function reportRowActions(input: {
  reportStatus: string;
  listingStatus: string | null | undefined;
}): ReportRowAction[] {
  const actions: ReportRowAction[] = [];
  const listingStatus = input.listingStatus ?? null;

  if (listingStatus === 'approved') {
    actions.push('delist');
    actions.push('claim');
  }
  if (listingStatus === 'removed') {
    actions.push('relist');
    actions.push('claim');
    actions.push('purge');
  }
  if (input.reportStatus === 'pending') {
    actions.push('resolve');
    actions.push('dismiss');
  }
  return actions;
}

/** Whether an action is the destructive one that must be confirmed before firing. */
export function isDestructiveAction(action: ReportRowAction): boolean {
  return action === 'purge';
}

const REPORT_STATUS_CHIPS: Record<string, Chip> = {
  pending: { label: 'Pending', color: 'yellow' },
  resolved: { label: 'Resolved', color: 'green' },
  dismissed: { label: 'Dismissed', color: 'gray' },
};

/** Chip for a report's lifecycle status (falls back to the raw value / gray). */
export function reportStatusChip(status: string): Chip {
  return REPORT_STATUS_CHIPS[status] ?? { label: status, color: 'gray' };
}

const LISTING_STATUS_CHIPS: Record<string, Chip> = {
  draft: { label: 'Draft', color: 'gray' },
  pending: { label: 'Pending', color: 'yellow' },
  approved: { label: 'Live', color: 'green' },
  rejected: { label: 'Rejected', color: 'gray' },
  removed: { label: 'Delisted', color: 'red' },
};

/** Chip for a listing's store status (falls back to the raw value / gray). */
export function listingStatusChip(status: string | null | undefined): Chip {
  if (!status) return { label: 'Gone', color: 'dark' };
  return LISTING_STATUS_CHIPS[status] ?? { label: status, color: 'gray' };
}

const MOD_ACTION_CHIPS: Record<string, Chip> = {
  delist: { label: 'Delisted', color: 'red' },
  relist: { label: 'Relisted', color: 'green' },
  purge: { label: 'Purged', color: 'dark' },
  claim: { label: 'Ownership claimed', color: 'blue' },
  'report-resolve': { label: 'Report resolved', color: 'green' },
  'report-dismiss': { label: 'Report dismissed', color: 'gray' },
  // W13 post-approval management (Phase 1) — surfaced in the OWNER moderation-history
  // view (and the mod one). `owner-*` are the author's own visibility toggles.
  'reset-to-pending': { label: 'Reset to pending', color: 'yellow' },
  'owner-unpublish': { label: 'Unpublished by you', color: 'gray' },
  'owner-republish': { label: 'Republished by you', color: 'green' },
};

/** Chip for a moderation-event action, for the per-listing history view. */
export function moderationActionChip(action: string): Chip {
  return MOD_ACTION_CHIPS[action] ?? { label: action, color: 'gray' };
}

/** Human label for a report-row action button. */
export function reportActionLabel(action: ReportRowAction): string {
  switch (action) {
    case 'delist':
      return 'Delist';
    case 'relist':
      return 'Relist';
    case 'claim':
      return 'Claim';
    case 'purge':
      return 'Purge';
    case 'resolve':
      return 'Resolve';
    case 'dismiss':
      return 'Dismiss';
  }
}
