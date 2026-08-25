import { describe, expect, it } from 'vitest';
import { chipFocusTarget, confirmDismissTarget } from '../focus';

/**
 * The decision this pins is WHICH entry, not whether `.focus()` was called. Getting it wrong is
 * worse than the loss it replaces — unpredictable focus movement is harder to work around than
 * predictable loss — so each case names the removal it stands for.
 */
describe('chipFocusTarget', () => {
  const after = (visible: string[], position: number, item = 'removed') =>
    chipFocusTarget(visible, position, item, { focusWasInForm: true, sameType: true });

  it('lands on the entry that took the removed one’s place', () => {
    // ['a','removed','c'], removed at index 1 -> ['a','c'], and 'c' is now at 1.
    expect(after(['a', 'c'], 1)).toEqual({ kind: 'chip', entry: 'c' });
  });

  it('walks backwards when the LAST chip was removed', () => {
    // ['a','b','removed'], removed at index 2 -> ['a','b'], nothing at 2.
    expect(after(['a', 'b'], 2)).toEqual({ kind: 'chip', entry: 'b' });
  });

  it('stays on the first chip when the first was removed', () => {
    expect(after(['b', 'c'], 0)).toEqual({ kind: 'chip', entry: 'b' });
  });

  it('sends focus to the filter when the removal emptied the list', () => {
    expect(after([], 0)).toEqual({ kind: 'filter' });
  });

  it('returns the filter rather than the previous chip on an empty list', () => {
    // Guards the `position - 1` fallback specifically: on an empty list it must not resolve.
    expect(after([], 3)).toEqual({ kind: 'filter' });
  });

  it('falls to the first entry when the removed chip was not in the captured list', () => {
    // `indexOf` returns -1 when the submit raced a filter change. Landing somewhere inside the
    // list beats <body>, and index 0 is the only position meaningful without it.
    expect(after(['a', 'b'], -1)).toEqual({ kind: 'chip', entry: 'a' });
  });

  it('returns the filter for a not-found removal on an empty list', () => {
    expect(after([], -1)).toEqual({ kind: 'filter' });
  });

  describe('when the entry is STILL on the list', () => {
    /**
     * The server returns `fail(409)` whenever the removal matched nothing — a state it models
     * deliberately, because the page is served from a month-long Redis cache and goes stale. The
     * list is then unchanged, and the user must end up back on the chip they were on.
     *
     * Without this rule that happened only because the index coincidentally still resolved to the
     * same entry. It stops coinciding the moment anything else re-orders the list.
     */
    it('returns to the entry itself rather than trusting the captured index', () => {
      expect(after(['a', 'removed', 'c'], 1)).toEqual({ kind: 'chip', entry: 'removed' });
    });

    it('returns to the entry even when the list re-ordered under the captured index', () => {
      // Another moderator's add sorted a new entry in above it, so index 1 is now someone else.
      expect(after(['a', 'aa-new', 'removed'], 1)).toEqual({ kind: 'chip', entry: 'removed' });
    });
  });
  describe('the guards, which used to be invisible ifs at the call site', () => {
    /**
     * 🔴 Moving focus that was not ours to move is WORSE than leaving it. A moderator part-way
     * through typing a bulk list into the textarea gets yanked into the chip grid, where the next
     * Space or Enter opens a remove confirm they did not ask for. Nothing observed this while it
     * was an `if` in the component, and one of the two shipped inverted.
     */
    it('leaves focus alone when it was not inside the removed chip’s form', () => {
      expect(
        chipFocusTarget(['a', 'c'], 1, 'removed', { focusWasInForm: false, sameType: true })
      ).toEqual({ kind: 'none' });
    });

    it('leaves focus alone when the tab changed while the removal was in flight', () => {
      // `data.blocklist` is now a different type's entries, so "the entry at that index" would be
      // an unrelated blocklist.
      expect(
        chipFocusTarget(['a', 'c'], 1, 'removed', { focusWasInForm: true, sameType: false })
      ).toEqual({ kind: 'none' });
    });

    it('refuses on either guard, not only on both', () => {
      expect(chipFocusTarget([], 0, 'removed', { focusWasInForm: false, sameType: false })).toEqual(
        { kind: 'none' }
      );
    });
  });
});

describe('confirmDismissTarget', () => {
  it('returns to the chip when the confirm is dismissed from inside it', () => {
    expect(confirmDismissTarget('spam.example', true)).toEqual({
      kind: 'chip',
      entry: 'spam.example',
    });
  });

  it('leaves focus alone when Escape came from somewhere else on the page', () => {
    // Escape is a window handler: a moderator can be typing in the filter with the popover still
    // open and press it as a reflex. Focusing the chip would pull them out of the field.
    expect(confirmDismissTarget('spam.example', false)).toEqual({ kind: 'none' });
  });

  it('does nothing when no confirm is open', () => {
    expect(confirmDismissTarget(null, true)).toEqual({ kind: 'none' });
    expect(confirmDismissTarget(null, false)).toEqual({ kind: 'none' });
  });
});
