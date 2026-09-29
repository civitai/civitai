import { describe, expect, it } from 'vitest';
import { FEEDBACK_ROW_INTERACTIVE, feedbackRowExpands } from '$lib/feedback-row-click';

/** A plain left-click on the row itself, away from every control and with nothing selected. */
const plain = {
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  interactive: false,
  selection: '',
  expanded: false,
};

describe('feedbackRowExpands', () => {
  /**
   * The positive control, and it is first for the reason this app's tripwire file gives: every other
   * case here asserts `false`, and a predicate hard-wired to `false` would satisfy all of them.
   */
  it('expands on an ordinary left-click on the row', () => {
    expect(feedbackRowExpands(plain)).toBe(true);
  });

  /**
   * 🔴 THE CONTROLS IN THE ROW OWN THEIR OWN CLICKS. Each of these is a real element the queue
   * renders, and each has a job the row would otherwise steal: the checkbox selects for the bulk
   * bar, the username link opens user lookup, the issue link opens the board in a new tab, and the
   * `Open`/`Close` anchor is the affordance this handler is an enhancement OVER — expanding the row
   * underneath it navigates twice.
   *
   * They are one case per control rather than one case for the flag so the ledger is readable: the
   * caller computes `interactive` from `FEEDBACK_ROW_INTERACTIVE`, and the assertion below pins that
   * every one of these four is in that selector.
   */
  it.each([
    ['the selection checkbox', '[role="checkbox"]'],
    ['the username link', 'a'],
    ['the issue-number link', 'a'],
    ['the Open/Close anchor', 'a'],
  ])('does not expand when the click lands on %s', (_label, selector) => {
    expect(FEEDBACK_ROW_INTERACTIVE.split(', ')).toContain(selector);
    expect(feedbackRowExpands({ ...plain, interactive: true })).toBe(false);
  });

  /**
   * 🔴 A MODIFIED CLICK IS HOW THE TWO LINKS IN THE ROW ARE OPENED IN A TAB OR A WINDOW. Expanding
   * the row alongside that moves the page out from under the operator, and `goto` on the queue while
   * the browser is opening a background tab is exactly the behaviour a real `<a href>` exists to
   * preserve.
   */
  it.each([['ctrlKey'], ['metaKey'], ['shiftKey'], ['altKey']] as const)(
    'does not expand on a %s click',
    (modifier) => {
      expect(feedbackRowExpands({ ...plain, [modifier]: true })).toBe(false);
    }
  );

  /** Middle- and right-clicks are the browser's, not the row's. */
  it.each([[1], [2]])('does not expand on button %i', (button) => {
    expect(feedbackRowExpands({ ...plain, button })).toBe(false);
  });

  /**
   * A drag that ENDS inside the row raises a click at the end of it, and the message column is the
   * one cell operators copy out of. Collapsing their selection by expanding a panel underneath it
   * makes the row uncopyable.
   */
  it('does not expand when the click ended a text selection', () => {
    expect(feedbackRowExpands({ ...plain, selection: 'the list is empty' })).toBe(false);
  });

  /** How a nested control says it has already handled this click. */
  it('does not expand a click something else already handled', () => {
    expect(feedbackRowExpands({ ...plain, defaultPrevented: true })).toBe(false);
  });

  /**
   * 🔴 IT OPENS, IT NEVER CLOSES — the finding that made `expanded` a field. Collapsing the panel
   * destroys it and every unsaved character of the issue title, summary and ClickUp URL inside, and
   * making the whole nine-cell row the close target puts that one stray click away.
   *
   * The gesture that reaches it is ordinary, which is why the `selection` guard is not enough: a
   * DOUBLE-CLICK to select a word fires `click` twice, and the FIRST fires before the selection
   * exists, so that arm returns `true`. Asserted as a pair — the same click on a CLOSED row still
   * opens it, so this pins the asymmetry rather than a predicate that stopped working.
   */
  it('never collapses an already-open row, including on the first click of a double-click', () => {
    expect(feedbackRowExpands({ ...plain, expanded: true })).toBe(false);
    // The first click of a double-click: no selection yet, nothing else to stop it.
    expect(feedbackRowExpands({ ...plain, expanded: true, selection: '' })).toBe(false);
    // The control: the identical click on a closed row opens it.
    expect(feedbackRowExpands({ ...plain, expanded: false, selection: '' })).toBe(true);
  });
});

describe('FEEDBACK_ROW_INTERACTIVE', () => {
  /**
   * A syntactically valid selector list, asserted because the whole guard is one `closest()` call
   * away from silence: `Element.closest` THROWS on a malformed selector, and the handler that calls
   * it runs in a `.svelte` file no test here can execute.
   */
  it('is a comma-separated list of non-empty selectors', () => {
    const parts = FEEDBACK_ROW_INTERACTIVE.split(', ');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part).toMatch(/^[a-z]+$|^\[role="[a-z]+"\]$/);
  });
});
