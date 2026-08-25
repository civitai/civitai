import { describe, expect, it } from 'vitest';
import { chipFocusTarget } from '../focus';

/**
 * The decision this pins is WHICH entry, not whether `.focus()` was called. Getting it wrong is
 * worse than the loss it replaces — unpredictable focus movement is harder to work around than
 * predictable loss — so each case names the removal it stands for.
 */
describe('chipFocusTarget', () => {
  const after = (visible: string[], position: number) => chipFocusTarget(visible, position);

  it('lands on the entry that took the removed one’s place', () => {
    // ['a','b','c'], removed 'b' at index 1 -> ['a','c'], and 'c' is now at 1.
    expect(after(['a', 'c'], 1)).toBe('c');
  });

  it('walks backwards when the LAST chip was removed', () => {
    // ['a','b','c'], removed 'c' at index 2 -> ['a','b'], nothing at 2.
    expect(after(['a', 'b'], 2)).toBe('b');
  });

  it('stays on the first chip when the first was removed', () => {
    expect(after(['b', 'c'], 0)).toBe('b');
  });

  it('returns null when the removal emptied the list, so the caller uses the filter', () => {
    expect(after([], 0)).toBeNull();
  });

  it('returns null rather than the previous chip on an empty list', () => {
    // Guards the `position - 1` fallback specifically: on an empty list it must not resolve.
    expect(after([], 3)).toBeNull();
  });

  it('falls to the first entry when the removed chip was not in the captured list', () => {
    // `indexOf` returns -1 when the submit raced a filter change. Landing somewhere inside the
    // list beats <body>, and index 0 is the only position that is meaningful without it.
    expect(after(['a', 'b'], -1)).toBe('a');
  });

  it('returns null for a not-found removal on an empty list', () => {
    expect(after([], -1)).toBeNull();
  });
});
