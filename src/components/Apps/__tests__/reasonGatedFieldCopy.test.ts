import { describe, expect, it } from 'vitest';

import {
  reasonGatedFieldDescription,
  reasonGatedFieldError,
} from '~/components/Apps/reasonGatedFieldCopy';

/**
 * The copy a reason-gated free-text field renders.
 *
 * 🔴 WHY THIS FILE IS IN THE BLOCKING `unit` PROJECT. These two strings used to be built
 * inline in `ReasonGatedField`'s JSX, where the only thing asserting them was
 * `MessageAppOwnerModal.browser.test.tsx` — the browser tier, which is REPORT-ONLY in
 * this repo's CI. Measured: deleting the ` (max N)` suffix from the counter left every
 * blocking suite green, so the ceiling — the entire reason the `maxLength` prop was
 * added — was pinned by nothing that can stop a merge.
 *
 * The FLOOR-ONLY cases are asserted first and in full, because five pre-existing call
 * sites pass no ceiling and must keep byte-identical copy.
 *
 * Fixture numbers are pairwise distinct and none is a multiple of another (min 20,
 * max 2000 are the real bounds; lengths 0, 1, 7, 19, 20, 33, 2000, 2001), so an
 * assertion cannot pass by two different quantities coinciding.
 */

const MIN = 20;
const MAX = 2000;

describe('reasonGatedFieldDescription — the live counter', () => {
  it('an optional note has no counter at all', () => {
    expect(
      reasonGatedFieldDescription({ length: 7, minLength: MIN, maxLength: MAX, required: false })
    ).toBeUndefined();
    expect(
      reasonGatedFieldDescription({ length: 7, minLength: MIN, required: false })
    ).toBeUndefined();
  });

  /** The five legacy call sites. Their copy must not move. */
  it('with NO ceiling it is exactly the floor counter', () => {
    expect(reasonGatedFieldDescription({ length: 0, minLength: MIN, required: true })).toBe(
      '0/20 characters minimum'
    );
    expect(
      reasonGatedFieldDescription({ length: 33, minLength: MIN, maxLength: null, required: true })
    ).toBe('33/20 characters minimum');
    expect(
      reasonGatedFieldDescription({
        length: 19,
        minLength: MIN,
        maxLength: undefined,
        required: true,
      })
    ).toBe('19/20 characters minimum');
  });

  /**
   * 🔴 THE MUTANT THIS FILE EXISTS FOR: dropping the ` (max N)` suffix. Asserted as the
   * WHOLE string rather than a `toContain`, so a reworded suffix fails too.
   */
  it('with a ceiling it names the ceiling, appended to the same floor counter', () => {
    expect(
      reasonGatedFieldDescription({ length: 0, minLength: MIN, maxLength: MAX, required: true })
    ).toBe('0/20 characters minimum (max 2000)');
    expect(
      reasonGatedFieldDescription({ length: 2000, minLength: MIN, maxLength: MAX, required: true })
    ).toBe('2000/20 characters minimum (max 2000)');
  });

  /**
   * The floor and the ceiling must come from DIFFERENT inputs. A counter that rendered
   * one of them twice passes every case above whenever the two happen to coincide, so
   * the discriminating case feeds two values that cannot be confused.
   */
  it('the floor and the ceiling are distinct inputs', () => {
    expect(
      reasonGatedFieldDescription({ length: 1, minLength: 7, maxLength: 33, required: true })
    ).toBe('1/7 characters minimum (max 33)');
  });
});

describe('reasonGatedFieldError — the inline error', () => {
  it('an untouched required field shows no error (the neutral counter, not red)', () => {
    expect(
      reasonGatedFieldError({ length: 0, minLength: MIN, maxLength: MAX, required: true })
    ).toBeUndefined();
  });

  it('a required field with SOME text but not enough names the floor', () => {
    expect(reasonGatedFieldError({ length: 1, minLength: MIN, required: true })).toBe(
      'Enter at least 20 characters.'
    );
    expect(
      reasonGatedFieldError({ length: 19, minLength: MIN, maxLength: MAX, required: true })
    ).toBe('Enter at least 20 characters.');
  });

  it('a value exactly ON the floor clears it', () => {
    expect(
      reasonGatedFieldError({ length: 20, minLength: MIN, maxLength: MAX, required: true })
    ).toBeUndefined();
  });

  it('an optional note has no floor error however short it is', () => {
    expect(reasonGatedFieldError({ length: 1, minLength: MIN, required: false })).toBeUndefined();
  });

  it('a value exactly ON the ceiling clears it; one over does not', () => {
    expect(
      reasonGatedFieldError({ length: 2000, minLength: MIN, maxLength: MAX, required: true })
    ).toBeUndefined();
    expect(
      reasonGatedFieldError({ length: 2001, minLength: MIN, maxLength: MAX, required: true })
    ).toBe('Keep it to 2000 characters or fewer (currently 2001).');
  });

  it('a ceiling applies to an OPTIONAL note too — the server rejects it either way', () => {
    expect(
      reasonGatedFieldError({ length: 2001, minLength: MIN, maxLength: MAX, required: false })
    ).toBe('Keep it to 2000 characters or fewer (currently 2001).');
  });

  /**
   * 🔴 TOO-LONG OUTRANKS TOO-SHORT, and this is the case that can tell them apart: a
   * field whose floor sits ABOVE its ceiling is over-long and under-length at once. An
   * implementation that checked the floor first would name the wrong bound.
   */
  it('too-long wins when a value is somehow both', () => {
    expect(reasonGatedFieldError({ length: 7, minLength: 33, maxLength: 1, required: true })).toBe(
      'Keep it to 1 characters or fewer (currently 7).'
    );
  });

  it('with no ceiling given, no length can produce a ceiling error', () => {
    expect(
      reasonGatedFieldError({ length: 2001, minLength: MIN, maxLength: null, required: true })
    ).toBeUndefined();
    expect(reasonGatedFieldError({ length: 2001, minLength: MIN, required: true })).toBeUndefined();
  });
});
