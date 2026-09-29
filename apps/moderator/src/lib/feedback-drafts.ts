/**
 * What the operator has TYPED into the feedback detail panel but not yet posted.
 *
 * ⚠️ THE PANEL NO LONGER DESTROYS ITS OWN MARKUP, so this module is smaller than the reason it was
 * written. The sections used to be tabs, and a tab was a real navigation: the `{#if activeTab === …}`
 * chain rebuilt every other section on each click, taking whatever was typed into an uncontrolled
 * `<input>` with it. The sections are stacked now and none of them is conditional on a URL param.
 *
 * 🔴 THE SHAPE STAYS ANYWAY, AND IT IS NOT VESTIGIAL. `FeedbackPromote`'s boxes are still bound to
 * a draft the PARENT owns, because the parent is what survives the `invalidateAll()` every
 * successful write issues — an uncontrolled box would be reset by the reload that follows a triage
 * save while the operator was midway through writing an issue title. This file is only the shape and
 * the starting values; the `$state` proxy that carries them is created in `FeedbackDetail.svelte`.
 *
 * ⚠️ WHAT NEITHER SURVIVES: a reload whose result no longer contains the row destroys the keyed
 * `{#each}` entry in the queue, the `{#if open}` with it, and every draft inside. `FeedbackDetail`
 * states that precondition; nothing here can protect against it.
 */

/** The promote form's two mutually exclusive modes and every box either of them shows. */
export type FeedbackPromoteDraft = {
  /** `true` = attach to an existing issue (shows `bugId`), `false` = create one (title + summary). */
  attachMode: boolean;
  bugId: string;
  title: string;
  summary: string;
  /** The ClickUp task URL for a newly created issue. Optional — see the form's own note. */
  clickupUrl: string;
};

/**
 * The operator-typed boxes in the promote form, by their POSTED `name`.
 *
 * 🔴 A LEDGER, NOT A CONVENIENCE. It is asserted against the template's own `name=` attributes, so
 * adding a box to that form without adding it here — the exact edit that reintroduces an
 * uncontrolled input — fails a test instead of silently losing text again. It fails on a REMOVAL
 * too: a field left here after its box is gone is a draft nothing can ever fill.
 *
 * `attachMode` is deliberately absent: it is a toggle, not a box, and it posts through the hidden
 * `mode` input rather than under its own name.
 */
export const FEEDBACK_PROMOTE_DRAFT_FIELDS = ['bugId', 'title', 'summary', 'clickupUrl'] as const;

/**
 * A blank promote draft.
 *
 * Blank rather than seeded from the row: this form CREATES an issue, so there is no stored column
 * behind it to pre-fill from.
 */
export function makeFeedbackPromoteDraft(): FeedbackPromoteDraft {
  return { attachMode: false, bugId: '', title: '', summary: '', clickupUrl: '' };
}

/**
 * Whether this draft holds operator-typed text that unmounting the panel would discard.
 *
 * 🔴 IT IS THE ONLY THING STANDING BETWEEN A STRAY CLICK AND SOMEONE'S UNSAVED ISSUE. The queue
 * expands a row on a click anywhere in it, and `?open=` is single-valued — so opening report B
 * destroys report A's panel, and this draft lives in that panel's memory and nowhere else. The click
 * handler declines on exactly this predicate; everywhere else the gesture works.
 *
 * 🔴 IT IS DRIVEN BY `FEEDBACK_PROMOTE_DRAFT_FIELDS`, NOT BY A HAND-WRITTEN LIST OF FOUR BOXES, and
 * that is what makes it survive the form growing. That ledger is already asserted against the
 * template's own `name=` attributes, so a box added to `FeedbackPromote` without a ledger entry
 * fails a test — and once it is in the ledger it is dirty-checked here for free. A fifth box added
 * to a hand-written list here would silently not protect its own text.
 *
 * 🔴 `attachMode` IS DELIBERATELY NOT CONSULTED, AND THE MODE-SPLIT VERSION LOSES TEXT. The obvious
 * reading — "in create mode check title/summary/clickupUrl, in attach mode check bugId" — describes
 * what is VISIBLE, and the question here is what would be LOST. Flipping the toggle does not clear
 * the other branch's fields: type a title, flip to attach, click another row, and a mode-aware
 * predicate reports clean while the title goes with the panel. The whole object is discarded on
 * unmount, so the whole object is what gets tested.
 *
 * ⚠️ THE COST, so it is not discovered later: a non-empty box on the branch that is not showing
 * still declines the click, and the operator cannot see why the row went inert. That is the safe
 * direction — declining costs one extra click on the `Open` anchor, and the other error loses work
 * with no undo.
 *
 * Whitespace is not content: a stray space is not worth blocking a click over, and the action trims
 * every one of these fields before storing anyway.
 */
export function isFeedbackPromoteDraftDirty(draft: FeedbackPromoteDraft): boolean {
  return FEEDBACK_PROMOTE_DRAFT_FIELDS.some((field) => draft[field].trim() !== '');
}
