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
 * 🔴 THE COMMENT THIS REPLACES CLAIMED TWO ERRORS "CANNOT BE" LIVE AT ONCE, AND ITS ARGUMENT DID NOT
 * REACH THE CASE. It was: each form disables its own controls while submitting, and a success clears
 * the error. Both halves are true; neither excludes two errors. `disabled={…submitting}` guards
 * CONCURRENT submission — and the two forms are on different tabs, so they were never concurrent —
 * while a success clears only the SUCCEEDING form's error. Nothing in either sentence stops a refused
 * triage and a later refused promote from both being set.
 *
 * What actually keeps the set small is wiring, not this function: `FeedbackDetail` gives each form an
 * `onSubmit` that clears the OTHER one's error, so starting any submit leaves at most one live. That
 * makes the fallback below unreachable in the panel as it stands today. It is still written, and
 * still tested, because that wiring lives in a `.svelte` file with no test tier — so a rule that
 * behaves correctly on two live errors is the part that can be held down mechanically, and the part
 * that cannot is pinned by a source-text tripwire instead.
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
