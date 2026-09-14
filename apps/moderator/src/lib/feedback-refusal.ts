import { FEEDBACK_FORM_TAB, feedbackTabLabel, type FeedbackTab } from './feedback-tabs';

/** The forms in the detail panel that can be refused. Keyed the way `FEEDBACK_FORM_TAB` keys them. */
export type FeedbackFormName = keyof typeof FEEDBACK_FORM_TAB;

/**
 * Every form the banner speaks for, in the order it falls back through.
 *
 * A hand-written tuple rather than `Object.keys(FEEDBACK_FORM_TAB)`, so the order is a decision in
 * the source instead of an accident of object literal order — and pinned against those keys by test,
 * so a third form added to the mapping cannot quietly go unrepresented here.
 */
export const FEEDBACK_FORM_NAMES = ['triage', 'promote'] as const;

/**
 * The ONE message the panel's refusal banner shows, given both forms' current errors.
 *
 * 🔴 THE ACTIVE TAB'S OWN FORM WINS, AND THE PREVIOUS RULE — "triage always wins" — WAS A BUG.
 * A refusal is raised by a submit, and a submit needs its form on screen, so the operator is looking
 * at the tab that owns the refusal they just caused. Preferring a fixed form instead meant a stale
 * triage error outranked the promote refusal the operator had that second produced: the panel showed
 * a message about a save they had already moved on from, and the one they were waiting for never
 * appeared at all. That is precisely the failure the panel-level banner was introduced to prevent,
 * arriving through the banner itself.
 *
 * 🔴 TWO ERRORS CAN BE LIVE AT ONCE, AND THE FALLBACK BELOW IS REACHABLE. THIS PARAGRAPH HAS NOW
 * BEEN WRONG TWICE, IN THE SAME DIRECTION, AND THE HISTORY IS PART OF THE WARNING.
 *
 * Round 1 said the two forms "cannot both be live" because each disables its own controls while
 * submitting and a success clears the error. Both halves true; neither excludes two errors —
 * `disabled={…submitting}` guards CONCURRENT submission, and a success clears only the SUCCEEDING
 * form's error.
 *
 * Round 2 replaced that with "the cross-clearing `onSubmit` wiring makes it unreachable", and that
 * is wrong the SAME WAY: "every submit starts by clearing its counterpart" is true, and says nothing
 * about a submit start versus a PREVIOUSLY STARTED submit's response. A true sentence about one
 * ordering was read as a claim about a different one, twice.
 *
 * The path, walked through the sources this round rather than argued from:
 *   1. On Triage, the operator clicks a status button. `triageForm.onSubmit` clears
 *      `promoteForm.error`; the fetch starts.
 *   2. The status buttons are `disabled={triageForm.submitting}` — but the tab triggers are plain
 *      `<a>` links (`FeedbackTabs.svelte`) and nothing disables them. They click Issue.
 *   3. `{#if activeTab === 'triage'}` destroys that branch. `use:enhance`'s `destroy()` removes the
 *      submit listener and NOTHING ELSE (`@sveltejs/kit@2.66.0`, `runtime/app/forms.js:227-231`);
 *      the in-flight fetch keeps running, because the `AbortController` `enhance` passes to the
 *      submit hook is never aborted by anyone — `FormState` receives it and does not use it.
 *      `FeedbackDetail` is not destroyed either, so both `FormState`s survive intact.
 *   4. They submit promote. `promoteForm.onSubmit` clears `triageForm.error`, which is still null.
 *   5. The triage response lands and sets `triageForm.error`. The promote response lands and sets
 *      `promoteForm.error`. Both live.
 *
 * The cross-clearing wiring is still worth having — it collapses the COMMON orderings — but it is a
 * narrowing, not an exclusion. This function is what has to be correct when two are live, and the
 * behaviour below is correct: the active tab's own refusal wins, which in step 5 is the promote one
 * the operator is waiting for.
 *
 * ⚠️ Aborting the orphaned request was considered and REJECTED, not overlooked. It would need the
 * controller threaded out of `onSubmit` and fired from a component teardown, in a `.svelte` file no
 * test here can execute — and it makes a worse failure, not a better one: `enhance` returns early on
 * `AbortError` without invoking the callback at all, so a triage write the server may already have
 * COMMITTED would produce neither a confirmation nor a refusal. Leaving the response to land and be
 * ranked is the behaviour this function exists to get right.
 *
 * The message NAMES the owning tab when it is not the current one, so "your save was refused" also
 * says where to go and fix it.
 */
export function feedbackRefusal(
  errors: Record<FeedbackFormName, string | null>,
  activeTab: FeedbackTab
): string | null {
  const raised: Array<{ tab: FeedbackTab; message: string }> = [];
  for (const form of FEEDBACK_FORM_NAMES) {
    const message = errors[form];
    if (message) raised.push({ tab: FEEDBACK_FORM_TAB[form], message });
  }

  const chosen = raised.find((entry) => entry.tab === activeTab) ?? raised[0];
  if (!chosen) return null;

  return chosen.tab === activeTab
    ? chosen.message
    : `${chosen.message} (on the ${feedbackTabLabel(chosen.tab)} tab)`;
}
