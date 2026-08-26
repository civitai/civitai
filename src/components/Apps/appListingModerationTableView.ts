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

import { LISTING_KIND_LABELS } from '~/components/Apps/listingKindLabels';
import type { ModerationListingRow } from '~/server/services/blocks/app-listing.service';

/**
 * The DISPLAY status for the mod management table.
 *
 * An EXTERNAL listing awaiting its FIRST review is stored (atomically, by the
 * submit path) as an AppListing with `status='draft'` PLUS a live pending
 * AppListingPublishRequest. Its raw `status` reads 'draft', yet the submitter's
 * own my-submissions surface shows 'pending' (the request status) — so the two
 * surfaces disagree, and a mod filtering the mgmt table by "Pending" does NOT
 * see the item that most needs reviewing. Treat such a draft-with-a-live-pending
 * -request as EFFECTIVELY pending for the mod table's DISPLAY (bucket + badge)
 * and its status filter, so both agree on "awaiting first review".
 *
 * DISPLAY-ONLY: action availability still keys off the REAL `row.status` (the
 * caller passes `hasPendingRequest` to {@link listingModActions} separately).
 * Total — never throws.
 */
export function effectiveModerationStatus(
  row: Pick<ModerationListingRow, 'status' | 'pendingRequest'>
): string {
  return row.status === 'draft' && row.pendingRequest != null ? 'pending' : row.status;
}

/** The lifecycle actions a mod row can offer (a subset renders per row). */
export type ListingModAction =
  | 'review'
  | 'message-owner'
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
 *   - `message-owner`: EVERY row, EVERY status, BOTH kinds. See below.
 *   - `approved` → `reset-to-pending` (dual-kind — off-site + on-site re-queue) +
 *     `hide` (delist, dual-kind).
 *   - `removed`  → `relist` (dual-kind) + `claim` + `purge` (both off-site only).
 *   - `draft` / `rejected` → no LIFECYCLE action (read-only) beyond `message-owner`,
 *     unless a pending request makes `review` available.
 *
 * 🔴 `message-owner` IS UNCONDITIONAL, and that is a claim about the SERVER, not a
 * preference. `appListings.messageAppOwner` resolves its recipient through
 * `resolveListingAccess`, which branches on KIND and never on STATUS — so there is no
 * listing in this table the proc would refuse. Narrowing the button to (say) approved
 * rows would withhold it in exactly the states where a moderator most needs it: a
 * `rejected` or `draft` row is one a developer is being asked to FIX, and before this
 * change those rows rendered a dead `—` with no way to tell them what to fix.
 *
 * 🔴 It is placed AFTER `review` and BEFORE the lifecycle actions so the row reads in
 * increasing severity (Review → Message owner → Reset → Hide → … → Purge) and the
 * destructive `purge` stays rightmost. Do not move it after `purge`: the rendering
 * order in `AppListingsModerationTable` is this array's order, and a benign button to
 * the right of a red irreversible one is a misclick waiting to happen.
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

  // Messaging the owner is state-neutral and dual-kind — always offered.
  actions.push('message-owner');

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

/**
 * Whether an action opens the shared REASON-gated modal (`ListingModActionModal`,
 * whose one free-text field is `reason` and whose floor is `OFFSITE_MOD_REASON_MIN`).
 *
 * 🔴 `message-owner` is FALSE, and it is not an oversight. That action does not carry a
 * `reason` at all: `appListings.messageAppOwner` takes a SUBJECT and a BODY with their
 * own, different floors (`MOD_MESSAGE_SUBJECT_MIN` / `MOD_MESSAGE_BODY_MIN`), so it
 * routes to `MessageAppOwnerModal` instead. Answering `true` here would be a
 * predicate that reads "shows a reason textarea" while the surface shows none.
 */
export function actionRequiresReason(action: ListingModAction): boolean {
  return action !== 'review' && action !== 'message-owner';
}

/**
 * Whether an action routes to `MessageAppOwnerModal` rather than the shared
 * reason-gated one. The complement of `actionRequiresReason` over the MUTATING
 * actions — `review` is neither (it opens the publish-request review modal).
 */
export function actionOpensOwnerMessage(action: ListingModAction): boolean {
  return action === 'message-owner';
}

/** Human label for a mod action button. */
export function listingModActionLabel(action: ListingModAction): string {
  switch (action) {
    case 'review':
      return 'Review';
    case 'message-owner':
      return 'Message owner';
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
    ? { label: LISTING_KIND_LABELS.offsite, color: 'grape' }
    : { label: LISTING_KIND_LABELS.onsite, color: 'blue' };
}
