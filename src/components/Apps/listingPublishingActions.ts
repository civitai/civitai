import type { OwnerListingState } from '~/components/Apps/offsiteOwnerControls';
import {
  canOwnerRepublish,
  canOwnerUnpublish,
  ownerListingState,
} from '~/components/Apps/offsiteOwnerControls';
import type { AppRole } from '~/shared/constants/app-capabilities.constants';

/**
 * THE LEDGER OF OWNER PUBLISHING CONTROLS on the canonical authoring page's
 * **Publishing** tab (`/apps/listing/<appListingId>/edit?tab=publishing`).
 *
 * 🔴 WHY A LEDGER AND NOT JUST A FIX. PR #4154 consolidated `/apps/my-submissions` into
 * `/apps/mine` and orphaned `MySubmissionsList`, which was the only surface carrying the
 * owner **Unpublish** / **Republish** controls. The new page body contained zero
 * occurrences of `unpublish`. The gap was DISCLOSED in that PR and then reviewed three
 * times without being caught, because every round asked "is the new page correct?" and
 * none asked "is it COMPLETE?" — a question no per-assertion test can answer, since a
 * control that is simply absent has nothing to assert against.
 *
 * So the class of defect is: *a consolidation silently drops an author affordance and
 * passes every audit*. The instrument against that class is a ledger — an enumerated set
 * that fails when it SHRINKS as well as when it GROWS:
 *
 *   1. This module declares, per row state, the EXACT set of controls the surface offers.
 *   2. `ListingPublishingPanel.browser.test.tsx` renders each state, enumerates every
 *      interactive control the panel's action container actually contains, and asserts SET
 *      EQUALITY against this table. Deleting a control makes the rendered set smaller than
 *      the ledger; adding one makes it larger. Either way the test is red, and the author
 *      of the change has to come here and say what they meant.
 *   3. That enumeration also REFUSES any control in the container that does not declare a
 *      `data-author-action`, so "grew" cannot be evaded by forgetting the attribute.
 *
 * 🔴 THE LEDGER HAS ITSELF NOW SURVIVED A SECOND CONSOLIDATION, WHICH IS THE POINT OF
 * KEEPING IT. This PR moves the pair OFF the `/apps/mine` row and into the Publishing tab
 * — structurally the same move that dropped them the first time. The ledger went red on
 * that move, deliberately, and was re-pointed rather than deleted: it now enumerates the
 * PANEL's container instead of the row's. The one thing that genuinely LEFT the vocabulary
 * is `history`, and it left because it stopped being a control at all — it is a TAB now,
 * pinned by `appListingEditorTabs.test.ts`'s tab-set cases, not by a set comparison over
 * buttons. Deleting it here without that replacement guard would have been the #4154 shape
 * a third time.
 *
 * 🔴 SCOPE, STATED EXACTLY, BECAUSE THE OVERCLAIM IS THE DANGEROUS PART. The ledger sees
 * the controls inside the Publishing panel's ACTION CONTAINER and nothing else. It does not
 * see the panel's own explanatory alerts, the confirmation modal's Cancel/Unpublish buttons,
 * the History tab's Withdraw buttons, or any other tab. The modal half is MEASURED rather
 * than assumed — `ListingPublishingPanel.browser.test.tsx`'s "the ledger does not see the
 * confirmation modal's own buttons" opens it and re-reads the set — because "it is in a
 * portal so it cannot be in the container" is a claim about Mantine's rendering, and this
 * paragraph is the wrong place to be guessing about someone else's implementation.
 * An earlier version of this paragraph — on the `/apps/mine` row it replaces
 * — said "every author-facing control", which is false, and false in the worst direction:
 * it is exactly the sentence a future consolidation would cite as proof of coverage it does
 * not have. That is how the bug this ledger exists to catch happened in the first place.
 *
 * 🔴 THE STATE MACHINE ITSELF IS NOT RE-DERIVED HERE. `ownerListingState` in
 * `offsiteOwnerControls.ts` is the single client mirror of the server guard in
 * `offsite-moderation.service.ts#republishOwnListing` (the last moderation event must be
 * `owner-unpublish`), and the off-site list already depends on it. Re-implementing the
 * live/owner-hidden/mod-removed split here would be the second copy of a predicate, which
 * is how the two surfaces would come to disagree.
 */

/**
 * Every owner-facing control the Publishing tab can render, in the canonical order used
 * for comparison. Adding a control to the panel means adding it here first.
 *
 * - `unpublish` — owner takedown of a live (approved) listing.
 * - `republish` — the owner's way BACK from their own unpublish. Not optional: without it
 *   an owner unpublish is a one-way door only a moderator `relistListing` can reopen.
 *
 * 🔴 THERE IS NO CONSTANT MEMBER ANY MORE, and that is a real loss this file has to say
 * out loud. `history` used to sit here as the control present in EVERY state, which is
 * what made a state-dependent control's absence legible rather than looking like an empty
 * cell. With it gone, `mod-removed` and `inactive` both declare the EMPTY set — and an
 * empty set is exactly what a dropped control looks like. Two things replace the property:
 * the panel renders a STATEMENT in those states ({@link showModRemovedNotice} and its
 * inactive sibling), and the browser ledger asserts that statement is present by the same
 * mechanism it asserts the buttons are absent — a positive control for the two nulls.
 */
export const PUBLISHING_PANEL_ACTIONS = ['unpublish', 'republish'] as const;
export type PublishingPanelAction = (typeof PUBLISHING_PANEL_ACTIONS)[number];

/** Canonical-order sort, so a set comparison never fails on ordering alone. */
export function sortPublishingActions(actions: readonly string[]): string[] {
  const rank = (a: string) => {
    const i = (PUBLISHING_PANEL_ACTIONS as readonly string[]).indexOf(a);
    return i === -1 ? PUBLISHING_PANEL_ACTIONS.length : i;
  };
  return [...actions].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The ledger for an **owner**, keyed by {@link OwnerListingState}.
 *
 * 🔴 `mod-removed` HAS NEITHER TAKEDOWN CONTROL, AND THAT IS THE LOAD-BEARING CELL. The
 * server refuses an owner republish whose last event is a moderator action, with
 * "This listing was removed by a moderator and cannot be restored by its owner." Rendering
 * Republish there would be a button that can only fail; rendering Unpublish there would be
 * a button for a state the listing is already in.
 *
 * 🔴 `inactive` COVERS `draft`/`pending`/`rejected`. A listing that was never approved has
 * nothing to take down, so the absence here is a fact about the lifecycle, not an omission.
 * On those statuses `editorTabsFor` does not offer the tab at all — this cell is the
 * defence-in-depth half, for a panel mounted directly.
 */
export const OWNER_ACTIONS_BY_STATE: Readonly<
  Record<OwnerListingState, readonly PublishingPanelAction[]>
> = {
  live: ['unpublish'],
  'owner-hidden': ['republish'],
  'mod-removed': [],
  inactive: [],
};

/**
 * The ledger for a seated COLLABORATOR, in every state: NOTHING.
 *
 * 🔴 A SEAT IS NOT OWNERSHIP. Both `unpublishOwnListing` and `republishOwnListing` are
 * owner-scoped server-side and throw for anyone else, so an editor offered either control
 * gets a guaranteed red toast. One entry rather than a per-state table because the answer
 * does not depend on the state — and saying so once is what makes it checkable.
 *
 * 🔴 THIS IS WHY `role` IS LOAD-BEARING IN `editorTabsFor` FOR THE FIRST TIME. An editor
 * is not offered the Publishing TAB at all; this empty set is the panel-level restatement
 * of the same refusal, so mounting the panel for an editor still yields no control.
 */
export const EDITOR_ACTIONS: readonly PublishingPanelAction[] = [];

/** The subset of a listing this derivation reads. Structural, so any shape satisfies it. */
export type PublishingActionRow = {
  /** The LISTING's own status — `draft|pending|approved|rejected|removed`. */
  status: string;
  /** The listing's most-recent moderation-event action; only meaningful when `removed`. */
  lastModerationAction?: string | null;
  role: AppRole;
};

/** The owner-control state for a listing — the state the ledger is keyed on. */
export function listingOwnerState(row: PublishingActionRow): OwnerListingState {
  return ownerListingState({
    listingStatus: row.status,
    lastModerationAction: row.lastModerationAction,
  });
}

/**
 * The exact set of publishing controls this listing must render.
 *
 * 🔴 THE COMPONENT DOES **NOT** CALL THIS — it calls {@link showUnpublish} /
 * {@link showRepublish} per control, because it renders them as separate JSX branches rather
 * than mapping over a list. So this function and the DOM are two independent derivations, and
 * the property the ledger depends on — that they agree — is NOT structural here. It is
 * enforced by a dedicated seam test — "agrees with the per-control predicates the component
 * calls", in `src/components/Apps/__tests__/listingPublishingActions.test.ts` — which drives
 * all four states × both roles and asserts each predicate matches this list's membership.
 * Without that test the ledger would be comparing the DOM against a table nothing forces the
 * DOM to follow — i.e. pinning itself. Named explicitly because an earlier version of this
 * comment claimed the stronger, structural version, and a reader who believed it would have
 * deleted the seam test as redundant.
 */
export function listingPublishingActions(row: PublishingActionRow): PublishingPanelAction[] {
  if (row.role !== 'owner') return [...EDITOR_ACTIONS];
  const state = listingOwnerState(row);
  return [...OWNER_ACTIONS_BY_STATE[state]];
}

/** Does this listing offer Unpublish? Owner + live only — mirrors {@link canOwnerUnpublish}. */
export function showUnpublish(row: PublishingActionRow): boolean {
  return row.role === 'owner' && canOwnerUnpublish(listingOwnerState(row));
}

/** Does this listing offer Republish? Owner + owner-hidden only — see {@link canOwnerRepublish}. */
export function showRepublish(row: PublishingActionRow): boolean {
  return row.role === 'owner' && canOwnerRepublish(listingOwnerState(row));
}

/**
 * Is this listing a MODERATOR takedown, i.e. should it say so instead of offering a way back?
 *
 * Deliberately NOT gated on `role`: a seated collaborator looking at a taken-down app needs
 * the same explanation the owner gets. It is a statement, not an action, which is why it is
 * absent from {@link PUBLISHING_PANEL_ACTIONS}.
 */
export function showModRemovedNotice(row: PublishingActionRow): boolean {
  return listingOwnerState(row) === 'mod-removed';
}

/**
 * The message to show an owner after a successful `republishOwnListing`.
 *
 * 🔴 ONE SPELLING, because "republish" now has TWO successful outcomes and three surfaces
 * announce it. The server routes a republish to `pending` (re-review) instead of
 * `approved` whenever the listing's assets changed since the last approval — see
 * `republishOwnListing` in `offsite-moderation.service.ts`. All three call sites
 * previously hardcoded "it is live again", which is FALSE on that arm and is exactly the
 * kind of claim that survives a review because the mutation genuinely succeeded. Reading
 * the returned `status` in one place is what makes the wrong message impossible to write
 * by copying the neighbouring component.
 *
 * `kind` only changes the wording of the LIVE arm (an on-site app comes back online; an
 * off-site listing returns to the store), matching what the three surfaces already said.
 */
export function republishSuccessMessage(
  result: { status: 'approved' | 'pending' },
  kind?: 'onsite' | 'offsite' | string | null
): string {
  if (result.status === 'pending') {
    return 'Submitted for review — your listing images changed since it was last approved, so a moderator needs to take another look before it goes back up.';
  }
  return kind === 'offsite'
    ? 'App republished — it is live in the store again.'
    : 'App republished — it is live again.';
}
