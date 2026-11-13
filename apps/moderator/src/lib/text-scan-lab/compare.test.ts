import { describe, expect, it } from 'vitest';
import { defaultComparePair, resolvePair } from './compare';

describe('defaultComparePair', () => {
  it('compares the previous version with the newest', () => {
    expect(defaultComparePair([{ id: 9 }, { id: 7 }, { id: 3 }])).toEqual({ from: 7, to: 9 });
  });

  it('has nothing to compare with fewer than two versions', () => {
    expect(defaultComparePair([{ id: 9 }])).toBeNull();
    expect(defaultComparePair([])).toBeNull();
  });
});

describe('resolvePair', () => {
  const versions = [{ id: 9 }, { id: 7 }, { id: 3 }];

  it('keeps a pick whose versions are both present', () => {
    expect(resolvePair({ from: 3, to: 9 }, versions)).toEqual({ from: 3, to: 9 });
  });

  it('falls back to the default pair when either picked id is missing', () => {
    expect(resolvePair({ from: 4, to: 9 }, versions)).toEqual({ from: 7, to: 9 });
    expect(resolvePair({ from: 3, to: 4 }, versions)).toEqual({ from: 7, to: 9 });
  });

  it('uses the default pair with no pick, and none with one version', () => {
    expect(resolvePair(null, versions)).toEqual({ from: 7, to: 9 });
    expect(resolvePair({ from: 4, to: 9 }, [{ id: 9 }])).toBeNull();
  });
});
