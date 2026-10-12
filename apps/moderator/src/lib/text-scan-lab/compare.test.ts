import { describe, expect, it } from 'vitest';
import { defaultComparePair } from './compare';

describe('defaultComparePair', () => {
  it('compares the previous version with the newest', () => {
    expect(defaultComparePair([{ id: 9 }, { id: 7 }, { id: 3 }])).toEqual({ from: 7, to: 9 });
  });

  it('has nothing to compare with fewer than two versions', () => {
    expect(defaultComparePair([{ id: 9 }])).toBeNull();
    expect(defaultComparePair([])).toBeNull();
  });
});
