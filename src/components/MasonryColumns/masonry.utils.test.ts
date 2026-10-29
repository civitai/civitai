import { describe, expect, test } from 'vitest';
import { getColumnCount } from '~/components/MasonryColumns/masonry.utils';

describe('getColumnCount', () => {
  // A hidden container measures clientWidth 0 minus its padding: negative, and it used to become
  // a negative column count that threw from Array(n).
  test.each([-32, -1, 0, NaN, Infinity, -Infinity])('width %s is "not measured" (0)', (width) => {
    expect(getColumnCount(width, 320, 7)).toBe(0);
  });

  test('a measured width always gives at least one column', () => {
    expect(getColumnCount(1, 320, 7)).toBe(1);
    expect(getColumnCount(100, 320, 7)).toBe(1);
  });

  test('fits columns plus gaps, capped at the max', () => {
    expect(getColumnCount(672, 320, 7)).toBe(2);
    expect(getColumnCount(10_000, 320, 7)).toBe(7);
  });
});
