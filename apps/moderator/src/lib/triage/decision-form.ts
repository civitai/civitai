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

/** Presses the button for a decision key in the open item's action bar. A disabled button ignores
 *  the click, and a submit button's click runs the form's own checks first. */
export const pressDecisionKey = (index: number) =>
  document
    .querySelector<HTMLButtonElement>(
      `[data-triage-actions] button[data-triage-key="${index + 1}"]`
    )
    ?.click();
