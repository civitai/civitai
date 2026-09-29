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
