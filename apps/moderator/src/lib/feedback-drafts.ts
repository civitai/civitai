/**
 * What the operator has TYPED into the feedback detail panel but not yet posted.
 *
 * 🔴 THIS MODULE EXISTS BECAUSE A TAB CLICK IS A DESTRUCTIVE NAVIGATION. The panel renders exactly
 * one tab (`{#if activeTab === …}`), so every other tab's markup is destroyed and rebuilt on each
 * click. An uncontrolled `<input>` keeps what was typed in the DOM node and nowhere else, so it went
 * with the node: a half-written internal note or issue title was discarded by a click whose whole
 * purpose was to go and check something before finishing the sentence, with no warning and no undo.
 *
 * Holding the draft in `FeedbackDetail` — which SURVIVES that navigation, because the row's
 * `{#if open}` never goes false — is what makes the text outlive the markup. This file is only the
 * shape and the starting values; the `$state` proxy that carries them is created there.
 *
 * 🔴 This is the same protection `FormState`'s `reset: false` already gives after a REFUSAL, reached
 * through a route that option cannot see. `reset: false` stops `HTMLFormElement.reset()` blanking a
 * box; it says nothing about the box ceasing to exist.
 */

/** The promote form's two mutually exclusive modes and every box either of them shows. */
export type FeedbackPromoteDraft = {
  /** `true` = attach to an existing issue (shows `bugId`), `false` = create one (title + summary). */
  attachMode: boolean;
  bugId: string;
  title: string;
  summary: string;
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
export const FEEDBACK_PROMOTE_DRAFT_FIELDS = ['bugId', 'title', 'summary'] as const;

/**
 * A blank promote draft.
 *
 * Blank rather than seeded from the row: this form CREATES an issue, so there is no stored column
 * behind it to pre-fill from. That is the difference from the triage note, which is seeded from
 * `row.triageNote` and has to fall back to it — see `FeedbackDetail.svelte`.
 */
export function makeFeedbackPromoteDraft(): FeedbackPromoteDraft {
  return { attachMode: false, bugId: '', title: '', summary: '' };
}
