import { describe, expect, it } from 'vitest';
import { stepLightboxIndex } from '$lib/lightbox';

/**
 * Arrow-key paging. The interesting case is BACKWARDS off the front: JavaScript's `%` keeps the sign
 * of the dividend, so a single modulo returns `-1` and indexes off the end of the array — which in a
 * lightbox is a blank frame, not a crash, and therefore easy to ship.
 */
describe('stepLightboxIndex', () => {
  it('steps forward and wraps at the end', () => {
    expect(stepLightboxIndex(0, 1, 3)).toBe(1);
    expect(stepLightboxIndex(1, 1, 3)).toBe(2);
    expect(stepLightboxIndex(2, 1, 3)).toBe(0);
  });

  it('steps backward and wraps onto the LAST item, not onto -1', () => {
    expect(stepLightboxIndex(2, -1, 3)).toBe(1);
    expect(stepLightboxIndex(1, -1, 3)).toBe(0);
    expect(stepLightboxIndex(0, -1, 3)).toBe(2);
  });

  /**
   * Four is used rather than three here on purpose: with a length of 3 a wrong modulo can land on the
   * right answer by coincidence, because 3 is both the length and a plausible off-by-one.
   */
  it('wraps over a length that is not the step or the index', () => {
    expect(stepLightboxIndex(0, -1, 4)).toBe(3);
    expect(stepLightboxIndex(3, 1, 4)).toBe(0);
  });

  it('is a no-op on a single item, in both directions', () => {
    expect(stepLightboxIndex(0, 1, 1)).toBe(0);
    expect(stepLightboxIndex(0, -1, 1)).toBe(0);
  });

  it('never returns an index outside the set, for any start and either direction', () => {
    for (const length of [1, 2, 3, 4, 7]) {
      for (let i = 0; i < length; i++) {
        for (const delta of [1, -1]) {
          const next = stepLightboxIndex(i, delta, length);
          expect(Number.isInteger(next)).toBe(true);
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThan(length);
        }
      }
    }
  });

  /**
   * 🔴 0, never `NaN`. A `NaN` index reaches `items[NaN]` → `undefined` → an `<img src>` built from
   * `undefined`, which is a request to a path that is not an image. A bad INDEX is inert; a bad SRC
   * is a request.
   */
  it.each([
    ['an empty set', 0, 1, 0],
    ['a negative length', 0, 1, -3],
    ['a NaN index', Number.NaN, 1, 3],
    ['a NaN delta', 0, Number.NaN, 3],
    ['an infinite length', 0, 1, Number.POSITIVE_INFINITY],
  ] as Array<[string, number, number, number]>)(
    'returns 0 on %s',
    (_label, index, delta, length) => {
      expect(stepLightboxIndex(index, delta, length)).toBe(0);
    }
  );
});
