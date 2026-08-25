import { describe, expect, it } from 'vitest';
import { chipFocusTarget } from '../focus';

/**
 * The decision this pins is WHICH entry, not whether `.focus()` was called. Getting it wrong is
 * worse than the loss it replaces — unpredictable focus movement is harder to work around than
 * predictable loss — so each case names the removal it stands for.
 */
describe('chipFocusTarget', () => {
  const after = (visible: string[], position: number, item = 'removed') =>
    chipFocusTarget(visible, position, item);

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
      expect(chipFocusTarget(['a', 'removed', 'c'], 1, 'removed')).toEqual({
        kind: 'chip',
        entry: 'removed',
      });
    });

    it('returns to the entry even when the list re-ordered under the captured index', () => {
      // Another moderator's add sorted a new entry in above it, so index 1 is now someone else.
      expect(chipFocusTarget(['a', 'aa-new', 'removed'], 1, 'removed')).toEqual({
        kind: 'chip',
        entry: 'removed',
      });
    });
  });
});
