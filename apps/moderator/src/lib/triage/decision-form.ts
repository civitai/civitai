/** The selector of the form a decision key submits, or null when that key is off or has no form.
 *  `actions` and `enabled` are both in key order: digit `n + 1` picks index `n`. */
export const decisionFormSelector = (
  actions: readonly string[],
  enabled: readonly boolean[],
  index: number
): string | null => {
  const action = enabled[index] ? actions[index] : undefined;
  return action ? `[data-triage-actions] form[data-triage-action="${action}"]` : null;
};

/** Submits the form for a decision key, if there is one. */
export const submitDecisionForm = (
  actions: readonly string[],
  enabled: readonly boolean[],
  index: number
) => {
  const selector = decisionFormSelector(actions, enabled, index);
  if (selector) document.querySelector<HTMLFormElement>(selector)?.requestSubmit();
};
