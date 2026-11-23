import { describe, expect, it } from 'vitest';
import { isBrowsingLevelClaim } from '../browsing-level-claim';

describe('isBrowsingLevelClaim', () => {
  it.each([0, 31])('accepts the non-negative integer %s', (v) => {
    expect(isBrowsingLevelClaim(v)).toBe(true);
  });

  it.each([
    ['a negative integer', -1],
    ['a fraction', 1.5],
    ['a numeric string', '4'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('rejects %s', (_label, v) => {
    expect(isBrowsingLevelClaim(v)).toBe(false);
  });
});
