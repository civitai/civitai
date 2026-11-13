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

const decisionButton = (index: number) =>
  document.querySelector<HTMLButtonElement>(
    `[data-triage-actions] button[data-triage-key="${index + 1}"]`
  );

let defaultOpener: ((index: number) => void) | undefined;

/** Registers what a decision key with reasons opens. `reason-picker.svelte.ts` calls this when it
 *  loads and TriageShell imports that module, so a page calling `pressDecisionKey` outside TriageShell
 *  gets a plain click. The reason-list state lives in a rune module
 *  this file stays free of, so tests can import it. */
export const setReasonOpener = (open: (index: number) => void) => {
  defaultOpener = open;
};

/** Presses the button for a decision key in the open item's action bar. A disabled button ignores
 *  the click, and a submit button's click runs the form's own checks first. A decision that offers
 *  reasons (`data-triage-reasons`) opens the reason list instead, for the reason to be picked with a
 *  second press. */
export const pressDecisionKey = (
  index: number,
  openReasons: ((index: number) => void) | undefined = defaultOpener
) => {
  const button = decisionButton(index);
  if (!button || button.disabled) return;
  if (openReasons && button.dataset.triageReasons !== undefined) openReasons(index);
  else button.click();
};

/** Focus is on a button or link that Enter should activate itself: any of them except the selected
 *  row's link, which is where focus rests after a ruling or a row click and so carries no intent. */
export const keepsNativeEnter = (target: { closest?: (selector: string) => unknown } | null) =>
  !!target?.closest?.('button, a') && !target.closest('a[aria-current="true"]');

/** Presses a decision's button whatever it offers: how the reason list finishes the decision. */
export const clickDecision = (index: number) => decisionButton(index)?.click();
