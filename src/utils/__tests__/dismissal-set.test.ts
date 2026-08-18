import { describe, expect, it } from 'vitest';

import { addDismissals, pruneDismissals } from '~/utils/dismissal-set';

describe('addDismissals', () => {
  it('appends a new id after the existing ones', () => {
    expect(addDismissals([1, 2], 3)).toEqual([1, 2, 3]);
  });

  it('accepts a list and keeps the order given', () => {
    expect(addDismissals(['a'], ['c', 'b'])).toEqual(['a', 'c', 'b']);
  });

  it('deduplicates within the incoming list', () => {
    expect(addDismissals([], [7, 7, 8])).toEqual([7, 8]);
  });

  // The contract that keeps callers from writing storage for nothing.
  it('returns undefined when the id is already dismissed', () => {
    expect(addDismissals([1, 2], 2)).toBeUndefined();
  });

  it('returns undefined when every incoming id is already dismissed', () => {
    expect(addDismissals([1, 2], [2, 1])).toBeUndefined();
  });

  it('adds only the ids that are new', () => {
    expect(addDismissals([1], [1, 2])).toEqual([1, 2]);
  });

  it('does not mutate the input', () => {
    const dismissed = [1];
    addDismissals(dismissed, 2);
    expect(dismissed).toEqual([1]);
  });
});

describe('pruneDismissals', () => {
  it('drops ids that are no longer live', () => {
    expect(pruneDismissals([1, 2, 3], [1, 3])).toEqual([1, 3]);
  });

  it('returns undefined when every id is still live', () => {
    expect(pruneDismissals([1, 2], [2, 1, 3])).toBeUndefined();
  });

  it('returns undefined for an empty stored set', () => {
    expect(pruneDismissals([], [1])).toBeUndefined();
  });

  it('accepts a Set as the live collection', () => {
    expect(pruneDismissals(['a', 'b'], new Set(['b']))).toEqual(['b']);
  });

  // Documented hazard: callers must not call this before their live data lands.
  it('prunes everything when live is empty', () => {
    expect(pruneDismissals([1, 2], [])).toEqual([]);
  });

  it('preserves the stored order of what it keeps', () => {
    expect(pruneDismissals([3, 1, 2], [1, 2, 3])).toBeUndefined();
    expect(pruneDismissals([3, 1, 2], [2, 3])).toEqual([3, 2]);
  });

  it('does not mutate the input', () => {
    const dismissed = [1, 2];
    pruneDismissals(dismissed, [1]);
    expect(dismissed).toEqual([1, 2]);
  });
});
