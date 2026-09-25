/**
 * What the operator has TYPED into the feedback detail panel but not yet posted.
 *
 * 🔴 THIS MODULE EXISTS BECAUSE A TAB CLICK IS A DESTRUCTIVE NAVIGATION. The panel renders exactly
 * one tab (`{#if activeTab === …}`), so every other tab's markup is destroyed and rebuilt on each
 * click. An uncontrolled `<input>` keeps what was typed in the DOM node and nowhere else, so it went
 * with the node: a half-written internal note or issue title was discarded by a click whose whole
 * purpose was to go and check something before finishing the sentence, with no warning and no undo.
 *
 * Holding the draft in `FeedbackDetail` — which SURVIVES that navigation, because `feedbackTabHref`
 * preserves `?open=` and so the row's `{#if open}` stays true across a tab click — is what makes the
 * text outlive the markup. This file is only the shape and the starting values; the `$state` proxy
 * that carries them is created there.
 *
 * ⚠️ "Survives a tab click" is the whole claim, and it used to be written as the wider "`{#if open}`
 * never goes false". That is false: a reload whose result no longer contains the row destroys the
 * keyed `{#each}` entry, the `{#if}` with it, and every draft inside. `FeedbackDetail.svelte` states
 * the precondition; nothing in this file can protect against it.
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
 * behind it to pre-fill from. That is the difference from the triage note, which is seeded from
 * `row.triageNote` and has to fall back to it — see `FeedbackDetail.svelte`.
 */
export function makeFeedbackPromoteDraft(): FeedbackPromoteDraft {
  return { attachMode: false, bugId: '', title: '', summary: '', clickupUrl: '' };
}

/**
 * What the triage note box should hold after a save SUCCEEDS.
 *
 * 🔴 THE POINT IS THE IN-FLIGHT WINDOW. Only the status buttons are disabled while the triage form
 * is submitting — the textarea is not — so the operator can keep typing between the click and the
 * response. Re-seeding unconditionally from the reloaded column discards whatever they added. The
 * unbound `value=` this branch replaced happened not to, in the sub-case where the stored column
 * came back unchanged (Svelte's `set_value` early-returns on an unchanged cached value), so the
 * unconditional re-seed was a narrow regression against it.
 *
 * The rule: the operator's text wins whenever it differs from what was posted. When it does NOT
 * differ they have typed nothing since, so the reloaded column — which may hold a server-side
 * normalisation, or another moderator's write that this save raced — is the better value.
 *
 * @param current what the box holds now
 * @param posted what this submit actually sent, or `null` when nothing was captured (no submit in
 * flight, or an `onSubmit` that never ran) — in which case the stored column wins, matching the
 * unconditional behaviour rather than inventing a third one
 * @param stored the column as it reads after the reload
 */
export function reseedTriageNote(current: string, posted: string | null, stored: string): string {
  if (posted === null) return stored;
  return current === posted ? stored : current;
}
