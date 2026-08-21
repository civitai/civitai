import type { OwnerListingState } from '~/components/Apps/offsiteOwnerControls';
import {
  canOwnerRepublish,
  canOwnerUnpublish,
  ownerListingState,
} from '~/components/Apps/offsiteOwnerControls';
import type { AppRole } from '~/shared/constants/app-capabilities.constants';

/**
 * THE LEDGER OF AUTHOR ACTIONS ON AN `/apps/mine` ROW.
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
 *   1. This module declares, per row state, the EXACT set of controls the row offers.
 *   2. `MyAppsBody.authorActions.browser.test.tsx` renders each state, enumerates every
 *      interactive control the row's action container actually contains, and asserts SET
 *      EQUALITY against this table. Deleting a control makes the rendered set smaller than
 *      the ledger; adding one makes it larger. Either way the test is red, and the author
 *      of the change has to come here and say what they meant.
 *   3. That enumeration also REFUSES any control in the container that does not declare a
 *      `data-author-action`, so "grew" cannot be evaded by forgetting the attribute.
 *
 * The behavioural half — that each control fires the right procedure with the right input —
 * is asserted separately in the same file. A structural ledger type-checks past a button
 * wired to the wrong mutation.
 *
 * 🔴 THE STATE MACHINE ITSELF IS NOT RE-DERIVED HERE. `ownerListingState` in
 * `offsiteOwnerControls.ts` is the single client mirror of the server guard in
 * `offsite-moderation.service.ts#republishOwnListing` (the last moderation event must be
 * `owner-unpublish`), and the off-site list already depends on it. Re-implementing the
 * live/owner-hidden/mod-removed split here would be the second copy of a predicate, which
 * is how the two surfaces would come to disagree.
 */

/**
 * Every author-facing control an `/apps/mine` row can render, in the canonical order used
 * for comparison. Adding a control to a row means adding it here first.
 *
 * - `unpublish` — owner takedown of a live (approved) listing.
 * - `republish` — the owner's way BACK from their own unpublish. Not optional: without it
 *   an owner unpublish is a one-way door only a moderator `relistListing` can reopen.
 * - `history` — the per-row disclosure toggle. Present on every row regardless of state or
 *   role, which is exactly why it belongs in the ledger: it is the constant against which a
 *   state-dependent control's absence is legible rather than looking like an empty cell.
 */
export const AUTHOR_ROW_ACTIONS = ['unpublish', 'republish', 'history'] as const;
export type AuthorRowAction = (typeof AUTHOR_ROW_ACTIONS)[number];

/** Canonical-order sort, so a set comparison never fails on ordering alone. */
export function sortAuthorActions(actions: readonly string[]): string[] {
  const rank = (a: string) => {
    const i = (AUTHOR_ROW_ACTIONS as readonly string[]).indexOf(a);
    return i === -1 ? AUTHOR_ROW_ACTIONS.length : i;
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
 */
export const OWNER_ACTIONS_BY_STATE: Readonly<
  Record<OwnerListingState, readonly AuthorRowAction[]>
> = {
  live: ['unpublish', 'history'],
  'owner-hidden': ['republish', 'history'],
  'mod-removed': ['history'],
  inactive: ['history'],
};

/**
 * The ledger for a seated COLLABORATOR, in every state.
 *
 * 🔴 A SEAT IS NOT OWNERSHIP. Both `unpublishOwnListing` and `republishOwnListing` are
 * owner-scoped server-side and throw for anyone else, so an editor offered either control
 * gets a guaranteed red toast. One entry rather than a per-state table because the answer
 * does not depend on the state — and saying so once is what makes it checkable.
 */
export const EDITOR_ACTIONS: readonly AuthorRowAction[] = ['history'];

/** The subset of a row this derivation reads. Structural, so any row shape satisfies it. */
export type AuthorActionRow = {
  /** The LISTING's own status — `draft|pending|approved|rejected|removed`. */
  status: string;
  /** The listing's most-recent moderation-event action; only meaningful when `removed`. */
  lastModerationAction?: string | null;
  role: AppRole;
};

/** The owner-control state for a row — the state the ledger is keyed on. */
export function rowOwnerState(row: AuthorActionRow): OwnerListingState {
  return ownerListingState({
    listingStatus: row.status,
    lastModerationAction: row.lastModerationAction,
  });
}

/**
 * The exact set of author controls this row must render.
 *
 * 🔴 THE COMPONENT DOES **NOT** CALL THIS — it calls {@link showUnpublish} /
 * {@link showRepublish} per control, because it renders them as separate JSX branches rather
 * than mapping over a list. So this function and the DOM are two independent derivations, and
 * the property the ledger depends on — that they agree — is NOT structural here. It is
 * enforced by a dedicated seam test — "agrees with the per-control predicates the component
 * calls", in `src/components/Apps/__tests__/myAppsAuthorActions.test.ts` — which drives all
 * four states × both roles and asserts each predicate matches this list's membership. Without that test the ledger would be comparing the DOM against a table nothing
 * forces the DOM to follow — i.e. pinning itself. Named explicitly because an earlier version
 * of this comment claimed the stronger, structural version, and a reader who believed it
 * would have deleted the seam test as redundant.
 */
export function authorRowActions(row: AuthorActionRow): AuthorRowAction[] {
  if (row.role !== 'owner') return [...EDITOR_ACTIONS];
  const state = rowOwnerState(row);
  return [...OWNER_ACTIONS_BY_STATE[state]];
}

/** Does this row offer Unpublish? Owner + live only — mirrors {@link canOwnerUnpublish}. */
export function showUnpublish(row: AuthorActionRow): boolean {
  return row.role === 'owner' && canOwnerUnpublish(rowOwnerState(row));
}

/** Does this row offer Republish? Owner + owner-hidden only — see {@link canOwnerRepublish}. */
export function showRepublish(row: AuthorActionRow): boolean {
  return row.role === 'owner' && canOwnerRepublish(rowOwnerState(row));
}

/**
 * Is this row a MODERATOR takedown, i.e. should it say so instead of offering a way back?
 *
 * Deliberately NOT gated on `role`: a seated collaborator looking at a taken-down app needs
 * the same explanation the owner gets. It is a statement, not an action, which is why it is
 * absent from {@link AUTHOR_ROW_ACTIONS}.
 */
export function showModRemovedNotice(row: AuthorActionRow): boolean {
  return rowOwnerState(row) === 'mod-removed';
}
