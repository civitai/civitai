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
   * Whether a panel is mounted AND its promote draft holds unsaved text — the queue's
   * `data.openVisible && panelDirty`.
   *
   * 🔴 BOTH HALVES, AND NEITHER ALONE IS THE RIGHT FACT. `panelDirty` is lifted out of
   * `FeedbackDetail` and keeps its last value after that component is destroyed, so a dirty panel
   * that the operator then CLOSED would go on blocking every row in the queue; `openVisible` is what
   * says a panel exists for the flag to be about. And `openVisible` alone is the too-wide rule this
   * field replaced — see the guard.
   */
  openPanelDirty: boolean;
  /**
   * Whether the clicked row is the one already expanded — `data.open === id`.
   *
   * 🔴 IT IS ABOUT HISTORY, NOT ABOUT THE PANEL. The handler never toggles, so a click here would
   * navigate to the URL the page is already on — and `goto` pushes unconditionally
   * (`@sveltejs/kit@2.66.0` passes `replace_state: undefined` through to `history.pushState`, where
   * SvelteKit's own anchor handler defaults to `url.href === location.href`). The row advertises
   * itself with `cursor-pointer`, so every such click looked inert and silently ate one Back press.
   */
  alreadyOpen: boolean;
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
 * 🔴 IT DECLINES ON ONE THING ONLY: AN OPEN PANEL WHOSE DRAFT HAS UNSAVED TEXT IN IT. Expanding a
 * row unmounts whatever panel is open — `?open=` is single-valued, so switching rows destroys the
 * old one exactly as closing it would — and the promote draft lives in that panel's memory and
 * nowhere else. When it holds nothing, the unmount costs nothing and the click goes through.
 *
 * ⚠️ THIS REPLACES A RULE THAT DECLINED WHENEVER ANY PANEL WAS OPEN, which protected the same text
 * and took the gesture with it: after the first expand, no row in the queue responded to a click
 * again. Dirtiness is the fact that rule was reaching for.
 *
 * 🔴 WHY THE `selection` GUARD BELOW CANNOT COVER THIS, so nobody deletes one for the other: the
 * gesture that reaches an unmount is a DOUBLE-CLICK to select a word in another row's Message cell.
 * It fires `click` twice, and the FIRST lands before the selection exists — invisible to
 * `selection`, and now harmless on a clean panel and refused on a dirty one.
 *
 * ⚠️ THE COST, STATED: with unsaved text in the open panel, clicking another row does nothing and
 * gives no reason on screen. Reaching that report means its `Open` link, which still works and still
 * discards the draft — deliberately, because it is a labelled control rather than a stray click.
 */
export function feedbackRowExpands(click: FeedbackRowClick): boolean {
  if (click.alreadyOpen) return false;
  if (click.openPanelDirty) return false;
  if (click.defaultPrevented) return false;
  if (click.button !== 0) return false;
  if (click.ctrlKey || click.metaKey || click.shiftKey || click.altKey) return false;
  if (click.interactive) return false;
  return click.selection === '';
}
