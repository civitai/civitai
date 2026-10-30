/**
 * Every form the detail panel's refusal banner speaks for, in the order it falls back through.
 *
 * A hand-written tuple so the order is a decision in the source rather than an accident of object
 * literal order, and pinned by test against the forms the panel actually renders.
 */
export const FEEDBACK_FORM_NAMES = ['triage', 'promote'] as const;

export type FeedbackFormName = (typeof FEEDBACK_FORM_NAMES)[number];

/**
 * The ONE message the panel's refusal banner shows, given both forms' current errors.
 *
 * 🔴 THE FORM THAT SUBMITTED MOST RECENTLY WINS, AND A FIXED PREFERENCE IS A KNOWN BUG. The rule
 * this replaces was "triage always wins", and it shipped: refuse a triage save, then submit the
 * promote form and have that refused too, and the banner showed the OLDER triage message while the
 * refusal the operator had that second produced never appeared at all.
 *
 * ⚠️ THE PREVIOUS RULE RANKED BY THE ACTIVE TAB, AND THE TABS ARE GONE — the sections are stacked
 * and both forms are on screen at once. The tab was only ever a proxy for "the form the operator is
 * working in", which `lastSubmitted` says directly, so this is the same rule with the proxy removed.
 * There is no tab left to NAME in the message either: the banner sits directly above both sections,
 * so "where to go and fix it" is one screen away rather than one navigation.
 *
 * 🔴 TWO ERRORS CAN BE LIVE AT ONCE, and removing the tabs did not close that path — it shortened
 * it. Each form disables only its OWN submit control while in flight, so: click a status button
 * (triage in flight), click Create issue (promote in flight), then both responses land and both
 * refuse. `lastSubmitted` is `promote` there, which is the answer the operator is waiting for.
 *
 * ⚠️ THE `?? raised[0]` FALLBACK IS NOT REACHED BY THAT WALK, and running the two together is how
 * the comment this replaces got wrong three times. The simple statement, which needs no walk: the
 * fallback fires whenever no live refusal belongs to the form that last submitted — a standing
 * promote refusal still on screen after a triage save that SUCCEEDED is the ordinary case.
 */
export function feedbackRefusal(
  errors: Record<FeedbackFormName, string | null>,
  lastSubmitted: FeedbackFormName | null
): string | null {
  const raised = FEEDBACK_FORM_NAMES.flatMap((form) =>
    errors[form] ? [{ form, message: errors[form] as string }] : []
  );

  const chosen = raised.find((entry) => entry.form === lastSubmitted) ?? raised[0];
  return chosen ? chosen.message : null;
}
