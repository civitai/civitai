import {
  listingModActions,
  type ListingModAction,
} from '~/components/Apps/appListingModerationTableView';

/**
 * App Store Listings — which MODERATOR actions the listing DETAIL body may offer.
 *
 * Pure + React-free so the correctness gate lives in the blocking node `unit` project
 * (the `.browser.test.tsx` component suites are report-only), mirroring its siblings
 * `appListingDetailView` / `appListingModerationTableView`.
 *
 * 🔴 THE STATE MACHINE IS NOT RE-DERIVED HERE. {@link listingModActions} is the single
 * source for "which lifecycle actions does a listing in this status/kind admit", and the
 * mod management table already depends on it. This module contributes exactly two things
 * the table does not have to answer:
 *
 *   1. WHAT STATUS IS THE LISTING ON THIS SURFACE? The detail body is handed a
 *      `ListingDetail`, and that DTO carries no `status` field at all — see
 *      {@link detailListingStatus} for why the answer is nonetheless knowable, and why it
 *      is knowable only on the live arm.
 *   2. WHICH OF THE ADMITTED ACTIONS DOES THIS SURFACE IMPLEMENT? An overflow menu on a
 *      store page is not the mod management table, and the answer is a strict subset —
 *      {@link DETAIL_SURFACE_MOD_ACTIONS}.
 *
 * The result is an INTERSECTION, which is the property worth having: an action shows up
 * only when the state machine admits it AND this surface has wired it. If a future change
 * stops `listingModActions` offering `reset-to-pending` on an approved listing, the menu
 * item disappears here without anyone editing this file; and a member newly added to
 * {@link ListingModAction} is NOT silently adopted by this surface, because it is absent
 * from the subset below. Both directions fail closed.
 */

/**
 * The actions the DETAIL body implements, of the seven {@link ListingModAction}s.
 *
 * 🔴 THE FOUR OMISSIONS ARE DECISIONS, NOT GAPS, and each has a reason that is about this
 * surface rather than about effort:
 *
 *   - `review` — opens the off-site publish-request review modal, which needs an
 *     `OffsitePendingRow` (a publish REQUEST). The detail body holds a `ListingDetail`
 *     and no request, and `listingModActions` only offers it when one exists anyway.
 *   - `relist` / `claim` / `purge` — all reachable on `/apps/review`, which is where a
 *     moderator can also SEE a removed listing. This page cannot: its read
 *     (`appListings.getAppDetail`) is approved-only, so a listing in any state those
 *     three apply to renders as a 404 here. `relist` in particular is the one this
 *     surface can never offer — see the note on {@link detailListingStatus}.
 *
 * Every omitted lifecycle action is still reachable, one click away, via the menu's link
 * to the review queue.
 */
export const DETAIL_SURFACE_MOD_ACTIONS = ['message-owner', 'reset-to-pending', 'hide'] as const;
export type DetailSurfaceModAction = (typeof DETAIL_SURFACE_MOD_ACTIONS)[number];

/**
 * The two TAKEDOWN actions — the ones that put an approved listing off the store, take a
 * mod `reason`, and open the shared reason-gated confirm. `message-owner` is excluded
 * because it changes no listing state and routes to its own composer.
 *
 * 🔴 KEEPING BOTH IS THE POINT, and they are not redundant. `hide` (delist) is a pure
 * visibility flip that a moderator reverses in one click with `relist`. `reset-to-pending`
 * re-queues the app for REVIEW, so it comes back only when someone approves it again.
 * Same immediate effect on the store, completely different cost to undo — which is why
 * {@link takedownConsequenceCopy} makes each one name the other.
 */
export const DETAIL_TAKEDOWN_ACTIONS = ['reset-to-pending', 'hide'] as const;
export type DetailTakedownAction = (typeof DETAIL_TAKEDOWN_ACTIONS)[number];

/** Narrowing predicate for the takedown pair — used to route a menu click to the modal. */
export function isDetailTakedownAction(action: string): action is DetailTakedownAction {
  return (DETAIL_TAKEDOWN_ACTIONS as readonly string[]).includes(action);
}

/**
 * The `data-testid` stem each takedown owns, single-sourced.
 *
 * 🔴 SHARED BY THE MENU ITEM AND ITS CONFIRM, and that is the point: the two confirms are
 * one component parameterised by action, so a hand-typed id in either place is how a test
 * ends up opening `hide` and asserting against `reset-to-pending`'s modal — which would
 * pass, because both render the same shell. Menu item = `<stem>-menu-item`; the confirm's
 * fields = `<stem>-reason` / `<stem>-submit` / `<stem>-consequences`.
 */
export const TAKEDOWN_TESTID_STEM: Record<DetailTakedownAction, string> = {
  'reset-to-pending': 'apps-listing-unpublish',
  hide: 'apps-listing-hide',
};

/**
 * The listing's lifecycle status as this surface can honestly claim it, or `null` when
 * the surface cannot claim one.
 *
 * 🔴 `ListingDetail` HAS NO `status` FIELD — this is derived from the READ PATH, and that
 * is the whole subtlety. `getListingDetail` returns `null` unless `row.status ===
 * 'approved'`, so anything the live `/apps/store-preview/<slug>` route renders is an
 * approved listing by construction; a listing in any other status 404s before this
 * component mounts.
 *
 * 🔴 IN `preview` THE SAME INFERENCE IS FALSE, which is why this returns `null` rather
 * than a status. The moderator review modal renders this body over
 * `getListingPreviewForReview`, which is deliberately NOT status-filtered (it exists to
 * show a DRAFT/shadow listing), and falls back to `buildListingDetailPreview`, which
 * builds a `ListingDetail` from a publish-request row — whose `id` is
 * `row.appListingId ?? row.id`, i.e. it can be the REQUEST's id rather than an
 * `AppListing` id at all. So in preview neither the status nor the identity of
 * `detail.id` is guaranteed, and every mod action keyed on either would be a control
 * that can fail. `null` is the honest answer, and it is what makes the whole mod section
 * absent there.
 *
 * 🔴 CONSEQUENCE, STATED BECAUSE IT IS THE DESIGN QUESTION THIS MODULE ANSWERS: `relist`
 * is structurally unreachable from this surface. It applies to a `removed` listing, and
 * a `removed` listing 404s on the route. Rendering it would be a button that can only
 * fail — the same reasoning `listingPublishingActions.ts` applies to the owner's
 * Republish control on a mod-removed listing.
 */
export function detailListingStatus(input: { preview: boolean }): 'approved' | null {
  return input.preview ? null : 'approved';
}

/**
 * The moderator actions to render in the detail body's `⋮` menu, in the canonical order
 * {@link listingModActions} defines (Message owner before the lifecycle actions).
 *
 * Empty for a non-moderator and empty in `preview`. The client gate is COSMETIC — every
 * proc behind these items is `moderatorProcedure` plus an inner `isModerator` recheck,
 * which is the real boundary — but rendering a control a viewer's session cannot use is
 * its own defect, so it is spelled here once rather than at each item.
 */
export function appListingDetailModActions(input: {
  isModerator: boolean;
  preview: boolean;
  kind: string;
}): DetailSurfaceModAction[] {
  if (!input.isModerator) return [];
  const status = detailListingStatus({ preview: input.preview });
  if (status === null) return [];
  return listingModActions({
    status,
    kind: input.kind,
    // This surface never holds a publish REQUEST, so it can never offer `review`.
    hasPendingRequest: false,
  }).filter(isDetailSurfaceModAction);
}

/** Type guard for the surface subset — a narrowing `includes`, kept out of the filter. */
function isDetailSurfaceModAction(action: ListingModAction): action is DetailSurfaceModAction {
  return (DETAIL_SURFACE_MOD_ACTIONS as readonly string[]).includes(action);
}

/**
 * The menu label for a moderator action on THIS surface.
 *
 * 🔴 DELIBERATELY NOT `listingModActionLabel`. That module's labels are written for a
 * dense table of buttons where the column header and the row's status badge supply the
 * context — "Reset to pending" reads fine beside a status chip and is meaningless in a
 * store page's overflow menu. More importantly the honest name for what the proc does is
 * not "reset": it takes the app OFF the store (and, on-site, STOPS IT SERVING) and
 * re-queues it for review. A label reading only "Unpublish" would understate the
 * re-queue; one reading only "Reset to pending" understates the takedown.
 */
export function detailModActionLabel(action: DetailSurfaceModAction): string {
  switch (action) {
    case 'message-owner':
      return 'Contact app owner';
    case 'reset-to-pending':
      return 'Unpublish and send back to review';
    case 'hide':
      // 🔴 The label carries the UNDO cost, because that is the only thing that
      // distinguishes this from the item directly above it in the menu. Both take the app
      // off the store; only this one comes back without a re-review. A moderator picking
      // between two items that both read "Unpublish" would be choosing at random.
      return 'Hide from store (reversible)';
  }
}

/**
 * What a reviewer is told will happen before they confirm a takedown — for BOTH actions
 * and BOTH kinds, in one place, so the two are written against each other rather than
 * separately.
 *
 * 🔴 WRITTEN FROM WHAT THE SERVER DOES, not from what the action is called.
 *
 * The KIND axis is the runtime stop. An on-site listing is 1:1 with a backing app block
 * and the block's serving gate reads the BLOCK's status, so every action that hides an
 * on-site listing also suspends the block (`flipBackingBlockStatus`, approved→suspended)
 * — the app stops serving, not merely stops being listed. An off-site listing has no
 * block, so there is nothing to stop; claiming otherwise would be asserting a consequence
 * that does not happen.
 *
 * The ACTION axis is the cost of undoing it, and it is the whole reason both items exist:
 *
 *   - `hide` → `delistListing` flips the listing approved→removed and stops there. A
 *     moderator puts it straight back with `relist`, unchanged, in one click.
 *   - `reset-to-pending` → `resetListingToPending` / `resetOnsiteListingToPending` also
 *     queue a FRESH review request carrying the current version (the owner resubmits
 *     nothing), so it returns only when a moderator approves that request.
 *
 * Both notify the owner and both write one audit event carrying the reason. NEITHER is
 * undoable from this page — the read here is approved-only, so the listing 404s the
 * moment it lands — which is why both sentences point at the review queue rather than
 * implying a way back on screen.
 *
 * 🔴 EACH ARM NAMES THE OTHER ACTION. A moderator choosing between two menu items that
 * both take the app down needs the contrast at the point of decision, not in a runbook.
 */
export function takedownConsequenceCopy(action: DetailTakedownAction, kind: string): string {
  const stop =
    kind === 'onsite'
      ? 'The app stops serving immediately and its listing leaves the store.'
      : 'The listing leaves the store.';
  const outcome =
    action === 'hide'
      ? 'Nothing is re-queued and nothing is re-reviewed: a moderator puts it back exactly ' +
        'as it is, in one click, with Relist in the review queue. Choose "Unpublish and ' +
        'send back to review" instead if the app has to CHANGE before it returns.'
      : 'A fresh review request is queued with the current version — the owner resubmits ' +
        'nothing — and it goes back up only when a moderator approves that request. ' +
        'Choose "Hide from store" instead if you expect to put it back unchanged.';
  return (
    `${stop} ${outcome} The owner is notified with the reason you give below, and it is ` +
    'recorded in this listing’s moderation history. Neither action can be undone from ' +
    'this page — the store detail is approved-only, so this listing will 404 here as soon ' +
    'as you confirm.'
  );
}
