/**
 * App Store Listings (W13 post-approval mgmt, P2) — the MOD MANAGEMENT TABLE view
 * model (pure, React-free). The per-row lifecycle ACTION SET, computed from a
 * listing's `status` + `kind` (+ whether a pending publish request exists), plus
 * the human labels. Extracted so the correctness gate lives in the blocking node
 * `unit` project (the civitai browser-mode suites are report-only), mirroring the
 * sibling `appListingModerationView` (the report-queue view model).
 *
 * KIND-AWARENESS (from the merged Phase 1 procs + the #3165 onsite reset backend):
 *   - `reset-to-pending` is DUAL-KIND — off-site routes through
 *     `resetListingToPending`, on-site through `resetOnsiteListingToPending` (which
 *     suspends the backing block + re-queues the block review). The caller routes by
 *     kind; the action is offered for an approved listing of EITHER kind.
 *   - `claim` / `purge` are OFF-SITE ONLY (the service raises NOT_FOUND for an
 *     on-site listing).
 *   - `hide` (delist) / `relist` are DUAL-KIND (they flip the on-site AppBlock too).
 *   - `review` opens the existing off-site review modal (approve/reject the pending
 *     request) → off-site only, and only when a pending request exists.
 */

/** The lifecycle actions a mod row can offer (a subset renders per row). */
export type ListingModAction =
  | 'review'
  | 'reset-to-pending'
  | 'hide'
  | 'relist'
  | 'claim'
  | 'purge';

/**
 * The ordered set of actions to render for a listing row.
 *
 *   - `review`: off-site + a pending publish request exists (any status — normally
 *     a `pending` listing, but a lingering pending request on another status still
 *     lets a mod open the review). Opens the reused off-site review modal.
 *   - `approved` → `reset-to-pending` (dual-kind — off-site + on-site re-queue) +
 *     `hide` (delist, dual-kind).
 *   - `removed`  → `relist` (dual-kind) + `claim` + `purge` (both off-site only).
 *   - `draft` / `rejected` → no lifecycle action (read-only) unless a pending
 *     request makes `review` available.
 */
export function listingModActions(input: {
  status: string;
  kind: string;
  hasPendingRequest: boolean;
}): ListingModAction[] {
  const offsite = input.kind === 'offsite';
  const actions: ListingModAction[] = [];

  // Review is available whenever there's a pending request to act on (off-site).
  if (offsite && input.hasPendingRequest) actions.push('review');

  if (input.status === 'approved') {
    // Reset-to-pending is now dual-kind: off-site → resetListingToPending, on-site →
    // resetOnsiteListingToPending (#3165). The mgmt table routes by kind.
    actions.push('reset-to-pending');
    actions.push('hide'); // delist — dual-kind
  }
  if (input.status === 'removed') {
    actions.push('relist'); // dual-kind
    if (offsite) {
      actions.push('claim');
      actions.push('purge');
    }
  }
  return actions;
}

/** Whether an action is the destructive one that must be confirmed before firing. */
export function isDestructiveListingModAction(action: ListingModAction): boolean {
  return action === 'purge';
}

/** Whether an action opens a reason-gated modal (all mutating actions require a reason). */
export function actionRequiresReason(action: ListingModAction): boolean {
  return action !== 'review';
}

/** Human label for a mod action button. */
export function listingModActionLabel(action: ListingModAction): string {
  switch (action) {
    case 'review':
      return 'Review';
    case 'reset-to-pending':
      return 'Reset to pending';
    case 'hide':
      return 'Hide';
    case 'relist':
      return 'Relist';
    case 'claim':
      return 'Claim';
    case 'purge':
      return 'Purge';
  }
}

/** Chip descriptor (label + Mantine color name) for a listing's store status. */
export type ListingKindChip = { label: string; color: string };

/** Chip for a listing's `kind` (the per-row kind badge). */
export function listingKindChip(kind: string): ListingKindChip {
  return kind === 'offsite'
    ? { label: 'external', color: 'grape' }
    : { label: 'on-site', color: 'blue' };
}
