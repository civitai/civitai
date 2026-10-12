import type { OwnerListingState } from '~/components/Apps/offsiteOwnerControls';
import {
  canOwnerRepublish,
  canOwnerUnpublish,
  ownerListingState,
} from '~/components/Apps/offsiteOwnerControls';
import type { AppRole } from '~/shared/constants/app-capabilities.constants';
import { maxVisibilityForStatus } from '~/shared/utils/app-listing-visibility';

/**
 * THE LEDGER OF OWNER PUBLISHING CONTROLS on the canonical authoring page's
 * **Publishing** tab (`/apps/listing/<appListingId>/edit?tab=publishing`).
 *
 * 🔴 WHY A LEDGER AND NOT JUST A FIX. PR #4154 consolidated `/apps/my-submissions` into
 * `/apps/mine` and orphaned `MySubmissionsList` (since deleted), which was the only surface carrying the
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
 * - `visibility` — the per-listing VISIBILITY LEVEL selector (`private` / `moderators` /
 *   `testers` / `public`).
 *
 * 🔴 `visibility` IS OWNER-ONLY *HERE*, AND THAT IS NARROWER THAN THE SERVER — BY DECISION,
 * NOT BY NECESSITY, AND AN EARLIER REVISION OF THIS FILE GOT IT WRONG IN THE OTHER
 * DIRECTION. `setListingVisibilityAsOwner` refuses only `!access || access.role == null`,
 * so an ACCEPTED collaborator genuinely passes the proc — and this file previously offered
 * the control to an editor on exactly that reasoning. The reasoning was sound about the
 * PROC and unreachable about the PRODUCT: `editorTabsFor` gates the Publishing tab on
 * `role === 'owner'`, so an editor can never mount the panel, and the branch produced
 * `['visibility']` for a role that is not there. The operator's call (2026-10-03) was to
 * widen the tab's STATUS term and leave `role` alone, so the editor branch was DELETED
 * rather than left dead. **To re-enable it, widen `editorTabsFor`'s `role` term first** —
 * the server will already allow it.
 *
 * 🔴 AND IT IS KEYED ON STATUS, NOT ON {@link OwnerListingState}, WHICH CANNOT EXPRESS IT.
 * That state machine collapses `draft`, `pending` AND `rejected` into one `inactive` cell,
 * but a level may be set on the first two and never on `rejected` — so a per-state table
 * would be wrong for a third of its own cell. {@link showVisibility} asks
 * `maxVisibilityForStatus` instead, which is the SAME function the server read and the
 * server write both use, so this is one spelling reaching the client rather than a second
 * derivation (D6).
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
export const PUBLISHING_PANEL_ACTIONS = ['unpublish', 'republish', 'visibility'] as const;
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
 * The ledger for a seated COLLABORATOR of the two OWNER-SCOPED controls, in every state:
 * NOTHING.
 *
 * 🔴 A SEAT IS NOT OWNERSHIP. Both `unpublishOwnListing` and `republishOwnListing` are
 * owner-scoped server-side and throw for anyone else, so an editor offered either control
 * gets a guaranteed red toast. One entry rather than a per-state table because the answer
 * does not depend on the state — and saying so once is what makes it checkable.
 *
 * 🔴 THIS IS WHY `role` IS LOAD-BEARING IN `editorTabsFor` FOR THE FIRST TIME. An editor
 * is not offered the Publishing TAB at all; this empty set is the panel-level restatement
 * of the same refusal, so mounting the panel for an editor still yields no control.
 *
 * ⚠️ IT IS STILL THE EDITOR'S WHOLE SET, AND ONE REVISION OF THIS FILE WRONGLY SAID IT WAS
 * NOT. That revision added `visibility` for a seat by composition, on the true observation
 * that the level proc admits an accepted collaborator — but `editorTabsFor` withholds the
 * Publishing tab from an editor entirely, so the composed branch described a configuration
 * the product cannot reach. The claim that the server would allow it survives; the claim
 * that an editor "renders exactly one control" did not, and it was removed rather than
 * reworded. The set is empty again because that is what the surface does.
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
  // 🔴 COMPOSED, NOT TABLE-LOOKED-UP, and the two halves are keyed on DIFFERENT things:
  // the takedown pair is role+`OwnerListingState`, the level control is role+STATUS.
  // Folding `visibility` into `OWNER_ACTIONS_BY_STATE` would force it through a state
  // machine that cannot express `draft`-yes/`rejected`-no — `inactive` contains both.
  // See {@link PUBLISHING_PANEL_ACTIONS}.
  const base =
    row.role === 'owner' ? OWNER_ACTIONS_BY_STATE[listingOwnerState(row)] : EDITOR_ACTIONS;
  const actions: PublishingPanelAction[] = [...base];
  if (showVisibility(row)) actions.push('visibility');
  return actions;
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
 * Does this listing offer the VISIBILITY LEVEL control?
 *
 * 🔴 OWNER-GATED, AND AN EARLIER REVISION DELIBERATELY WAS NOT — the correction is worth
 * reading before changing it back. `setListingVisibilityAsOwner` admits an owner OR an
 * ACCEPTED collaborator, so role-agnostic was the honest mirror of the PROC; it was not the
 * honest mirror of the PRODUCT, because `editorTabsFor` gates the Publishing tab on
 * `role === 'owner'` and an editor never mounts the panel at all. The branch therefore
 * described an unreachable configuration, and three test assertions pinned it. Owner-gated
 * here matches both siblings above and the tab that actually hosts this control.
 *
 * 🔴 THE STATUS TERM IS WHAT `editorTabsFor` WAS WIDENED TO MATCH, so this predicate and
 * that gate must be read together — the seam is pinned by `appListingEditorTabs.test.ts`'s
 * "every status `showVisibility` offers the level on also opens the Publishing tab". A
 * narrowing on either side silently kills the control again, which is exactly what
 * happened before that test existed.
 *
 * 🔴 ELIGIBILITY COMES FROM {@link maxVisibilityForStatus}, THE SHARED SPELLING — never a
 * local status list. `null` means no level may be set on this status at all
 * (`rejected`/`removed`). `inactive` in {@link OwnerListingState} cannot answer this
 * question: it contains `draft`/`pending` (eligible) AND `rejected` (not).
 *
 * ⚠️ PRESENCE IS NOT WRITABILITY. An un-migrated environment still shows the control —
 * the panel renders it DISABLED from `visibilityAvailable`, because a hidden control and a
 * disabled one say different things to an owner, and `assertVisibilityWritable` is the
 * authoritative refusal either way.
 */
export function showVisibility(row: PublishingActionRow): boolean {
  return row.role === 'owner' && maxVisibilityForStatus(row.status) !== null;
}

/**
 * What the store `⋮` menu's owner "Visibility" item should show once clicked.
 *
 * The card and detail DTOs carry no status, role or level, so the menu fetches the
 * owner-scoped authoring context only when the item is clicked, and this decides what to
 * render from that read. Eligibility is {@link showVisibility} on the FETCHED row — the
 * same predicate the Publishing tab uses — so the menu cannot offer the picker where the
 * tab would not.
 *
 *   - `loading` — no context yet and no error.
 *   - `error` — the read failed (e.g. FORBIDDEN for a caller without a role).
 *   - `ineligible` — loaded, but `showVisibility` refuses this row (not the owner, or a
 *     status on which no level may be set).
 *   - `ready` — render the picker.
 */
export type OwnerVisibilityLoadState = 'loading' | 'error' | 'ineligible' | 'ready';

export function ownerVisibilityLoadState(input: {
  isError: boolean;
  context: PublishingActionRow | null | undefined;
}): OwnerVisibilityLoadState {
  if (input.context) return showVisibility(input.context) ? 'ready' : 'ineligible';
  return input.isError ? 'error' : 'loading';
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
 * `approved` when the listing's assets differ from the ones recorded at its last
 * approval — see `republishOwnListing` in `offsite-moderation.service.ts`. All three call
 * sites previously hardcoded "it is live again", which is FALSE on that arm and is exactly
 * the kind of claim that survives a review because the mutation genuinely succeeded.
 * Reading the returned `status` in one place is what makes the wrong message impossible to
 * write by copying the neighbouring component.
 *
 * 🔴 AND THE REVIEW ARM HAS MORE THAN ONE REASON, so it must not have one message. The
 * server returns `reviewReason` alongside `status`; `'assets-changed'` is the case the
 * feature exists for, but `'unreadable-baseline'` fires when the recorded comparison point
 * cannot be read — nothing about the owner's images necessarily changed, and telling them
 * "your listing images changed" would be a flat assertion about their own actions that we
 * have no evidence for. An unrecognised reason falls back to the neutral wording rather
 * than to the specific one, so a reason added server-side can never silently inherit a
 * claim it does not support.
 *
 * `kind` only changes the wording of the LIVE arm (an on-site app comes back online; an
 * off-site listing returns to the store), matching what the three surfaces already said.
 */
export function republishSuccessMessage(
  result: { status: 'approved' | 'pending'; reviewReason?: string | null },
  kind?: 'onsite' | 'offsite' | string | null
): string {
  if (result.status === 'pending') {
    return result.reviewReason === 'assets-changed'
      ? 'Submitted for review — your listing images changed since they were last approved, so a moderator needs to take another look before it goes back up.'
      : 'Submitted for review — we could not confirm your listing images against the last approved version, so a moderator needs to take another look before it goes back up.';
  }
  return kind === 'offsite'
    ? 'App republished — it is live in the store again.'
    : 'App republished — it is live again.';
}

/**
 * The message to show after a successful `withdrawExternalRequest`.
 *
 * 🔴 A PURE FUNCTION RATHER THAN A TERNARY IN THE PANEL, so this branch is covered by the
 * BLOCKING node `unit` project — the browser-mode component suites are report-only, and
 * this particular claim is the one that matters most to get right.
 *
 * 🔴 THE TWO OUTCOMES ARE NOT EQUALLY REVERSIBLE, and one sentence covered both.
 * `'deleted'` discards a draft. `'removed'` closes the review of a formerly-LIVE listing:
 * the server writes a `delist` event, which `republishOwnListing`'s guard reads as a
 * MODERATOR takedown — so the owner cannot put the listing back and must ask a moderator.
 * That is deliberate (it closes a self-restore exploit), which is exactly why the owner
 * has to be told, rather than discovering it as a "removed by a moderator" state they
 * caused themselves. `'none'` means this call changed nothing (already withdrawn, or it
 * lost the race), so it must not narrate someone else's close.
 */
export function withdrawSuccessMessage(outcome?: string | null): string {
  return outcome === 'removed'
    ? 'Submission withdrawn — your listing is off the store. Ask a moderator to restore it when you are ready.'
    : 'Submission withdrawn.';
}
