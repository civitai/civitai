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
  openPanelDirty: false,
  alreadyOpen: false,
};

describe('feedbackRowExpands', () => {
  /**
   * The positive control, and it is first for the reason this app's tripwire file gives: every other
   * case here asserts `false`, and a predicate hard-wired to `false` would satisfy all of them.
   *
   * ⚠️ `plain` IS THE ONE INPUT THAT EXPANDS, AND THERE CANNOT BE A SECOND. This file used to carry
   * three positives — "ordinary click", "clean draft", "nothing open" — whose inputs were
   * byte-identical to `plain`, each with a docstring claiming a distinct arm. Measured: deleting the
   * `openPanelDirty` guard reddened exactly one test and left all three green.
   *
   * The predicate collapses "no panel open" and "an open panel with nothing typed in it" into one
   * boolean BY DESIGN — what it is asked is whether unmounting costs anything, and both answer no.
   * So this is that case, once, under its real name.
   *
   * The distinction those cases were reaching for lives where it is expressible:
   * `feedbackPanelHasUnsavedDraft` in `feedback-drafts.test.ts` is what turns a row and a draft into
   * this boolean, and that is where a linked row, a clean draft and a dirty one are separable.
   */
  it('expands on an ordinary left-click with nothing at risk', () => {
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
   * 🔴 AND THE ARM THAT MUST NOT MOVE. `?open=` is single-valued, so expanding another row unmounts
   * the open panel — and the promote draft lives in that panel's memory and nowhere else, with no
   * undo and no second copy.
   *
   * 🔴 THE GESTURE THAT REACHES IT IS ORDINARY, WHICH IS WHY `selection` CANNOT COVER IT: a
   * DOUBLE-CLICK to select a word in another row's Message cell fires `click` twice, and the FIRST
   * lands before the selection exists. `plain` already carries `selection: ''`, so this fixture IS
   * that first click — there is nothing to add by spelling it a second time.
   *
   * ⚠️ AN EARLIER REVISION DID SPELL IT TWICE, with a comment calling the second one the
   * double-click case. The two inputs were byte-identical, so it pinned nothing the first did not —
   * the same defect this file's positive control records at the top, found by sweeping for it.
   */
  it('declines when the open panel holds unsaved text, double-click included', () => {
    expect(feedbackRowExpands({ ...plain, openPanelDirty: true })).toBe(false);
  });

  /**
   * 🔴 NOT ABOUT THE PANEL — ABOUT HISTORY, which is why it is a separate guard rather than folded
   * into the dirty one. The handler never toggles, so a click on the row that is already expanded
   * would `goto` the URL the page is on, and `goto` pushes unconditionally. The row carries
   * `cursor-pointer`, so every such click looked inert and silently ate one Back press.
   *
   * ⚠️ THIS CASE DOES NOT ESTABLISH THAT THE TWO GUARDS ARE INDEPENDENT, and an earlier annotation
   * here claimed it did. A fixture with BOTH flags set declines whichever guard survives, so it
   * passes with either one deleted. Independence is established by this case (`alreadyOpen` alone)
   * and by the dirty case above it (`openPanelDirty` alone), each of which fails when its own guard
   * goes — which is what the mutation run measured.
   */
  it('declines a click on the row that is already expanded', () => {
    expect(feedbackRowExpands({ ...plain, alreadyOpen: true })).toBe(false);
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
