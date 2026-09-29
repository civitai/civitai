/**
 * Whether a click anywhere on a queue row should expand it.
 *
 * 🔴 PROGRESSIVE ENHANCEMENT ONLY. Every row carries a real `Open`/`Close` anchor, and that anchor
 * is the no-JS surface and the keyboard affordance both — this predicate runs on top of it and must
 * never become the only way in. It is a plain function rather than a handler in `+page.svelte`
 * because this app has no Svelte test tier, so logic written there is logic nothing can assert.
 */

/**
 * The controls a row renders, as the selector `Element.closest` is given.
 *
 * 🔴 A CLICK ON ANY OF THESE BELONGS TO THAT CONTROL, NOT TO THE ROW. The row holds a
 * `SelectionCheckbox` (bits-ui renders a `<button role="checkbox">`), the reporter's username link,
 * the issue-number link (`target="_blank"`), and the `Open`/`Close` anchor. Expanding the row
 * underneath any of them either fights the control — a selection tick that also opens a panel — or
 * navigates twice.
 *
 * `input`, `label`, `select` and `textarea` are listed although the row renders none today: this
 * selector is what makes adding one to a cell safe, and the cheap direction to be wrong in is
 * ignoring a click the row could have handled.
 */
export const FEEDBACK_ROW_INTERACTIVE =
  'a, button, input, label, select, textarea, [role="checkbox"], [role="button"]';

export type FeedbackRowClick = {
  /** `MouseEvent.button` — 0 is the primary one. */
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  /** `event.target.closest(FEEDBACK_ROW_INTERACTIVE) !== null`. */
  interactive: boolean;
  /** `window.getSelection()?.toString() ?? ''`. */
  selection: string;
  /**
   * Whether a panel is MOUNTED — the queue's `data.openVisible`.
   *
   * 🔴 NOT `data.open === id`, WHICH IS TOO NARROW, AND NOT `data.open !== null`, WHICH IS TOO WIDE.
   * The queue keeps `?open=` when the id names a report the current view cannot show and says so in
   * a hint, so `open !== null` is true in a state where there is no panel and no draft — and the
   * guard would then kill the row click across the whole queue for nothing, on exactly the shared
   * link that lands an operator there. `openVisible` is `!!openRow`, computed off the same list the
   * rows render from, so it is true iff a panel exists to protect.
   */
  anyPanelOpen: boolean;
};

/**
 * 🔴 EVERY GUARD HERE PROTECTS A GESTURE THE ROW WOULD OTHERWISE SWALLOW, and each one is a
 * behaviour an operator already has:
 *   - a modified click is how the two links in the row are opened in a tab or a window, and a
 *     `goto` fired alongside it moves the page out from under them;
 *   - a drag that ENDS inside the row is a text selection — the message column is the one cell
 *     operators copy out of — and a click event fires at the end of it;
 *   - `defaultPrevented` is how a nested control says it has already handled this click.
 *
 * 🔴 IT OPENS FROM A QUEUE WITH NOTHING OPEN, AND DOES NOTHING OTHERWISE. Both other transitions
 * UNMOUNT a live panel: `?open=` is single-valued, so switching rows destroys the old one exactly as
 * closing does, and the panel is where the operator's issue title, summary and ClickUp URL live
 * (`FeedbackDetail` hoists that draft precisely because it is held in memory and nowhere else).
 *
 * 🔴 THE NARROWER TEST — "is THIS row open" — WAS WRONG, AND IT READ AS SAFE. It suppresses the
 * self-close and leaves every OTHER row a click away from discarding the draft: on a 50-row queue
 * that is 49 of the 50 strips, not 0. The gesture is ordinary, which is the point — a DOUBLE-CLICK
 * to select a word in another row's Message cell fires `click` twice, and the FIRST lands before the
 * selection exists, so the `selection` guard below cannot see it.
 *
 * ⚠️ THE COST, STATED: with a panel already open, clicking a row does nothing, and moving to another
 * report means its `Open` link — one deliberate click, which is what it took before this handler
 * existed. Expanding from a cold queue is the affordance this buys, and it is the common one.
 */
export function feedbackRowExpands(click: FeedbackRowClick): boolean {
  if (click.anyPanelOpen) return false;
  if (click.defaultPrevented) return false;
  if (click.button !== 0) return false;
  if (click.ctrlKey || click.metaKey || click.shiftKey || click.altKey) return false;
  if (click.interactive) return false;
  return click.selection === '';
}
