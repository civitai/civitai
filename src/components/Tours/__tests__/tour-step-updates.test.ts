import { describe, expect, it } from 'vitest';
import { nextTourSteps } from '~/components/Tours/tour-step-updates';
import type { StepWithData } from '~/types/tour';

const steps = (...keys: string[]): StepWithData[] =>
  keys.map((key) => ({ target: `[data-tour="${key}"]`, content: key }));

const GEN = steps(
  'gen:start',
  'gen:prompt',
  'gen:remix',
  'gen:remix-menu',
  'gen:submit',
  'gen:buzz',
  'gen:queue',
  'gen:feed',
  'gen:select',
  'gen:post'
);
const CUT_AT_FEED = GEN.slice(0, 8);

describe('nextTourSteps', () => {
  /**
   * The tour asks the user to generate, and `hasGeneratedImages` only flips once they
   * have. Computed once at step 0 and frozen, that left every first-timer cut at
   * `gen:feed` — without `gen:select`/`gen:post`, which is the handover to the
   * post-generation tour. The tail can only ever be appended, so taking it is safe.
   */
  it('adopts a longer tail found part-way through the tour', () => {
    expect(nextTourSteps(CUT_AT_FEED, GEN, 6)).toHaveLength(GEN.length);
  });

  /**
   * The terms filter DELETES a step, and accepting the terms mid-tour is exactly when it
   * starts matching — so this recomputation slides every later index down one and moves
   * the user off the step they are reading.
   */
  it('refuses a candidate that drops a step the user already walked past', () => {
    const withoutTerms = steps('gen:start', 'gen:prompt', 'gen:remix');
    const withTerms = steps('gen:start', 'gen:terms', 'gen:prompt', 'gen:remix');

    expect(nextTourSteps(withTerms, withoutTerms, 2)).toBeNull();
  });

  it('takes any candidate while the tour is still on its first step', () => {
    const withoutTerms = steps('gen:start', 'gen:prompt');
    const withTerms = steps('gen:start', 'gen:terms', 'gen:prompt');

    expect(nextTourSteps(withTerms, withoutTerms, 0)).toEqual(withoutTerms);
  });

  it('refuses a candidate too short to reach the current step', () => {
    expect(nextTourSteps(GEN, GEN.slice(0, 3), 6)).toBeNull();
  });

  /**
   * The effect runs on every step change, so an unchanged recomputation must not call
   * `setSteps` — a fresh array each time re-renders every tour consumer for nothing.
   */
  it('returns null when the targets are unchanged', () => {
    expect(nextTourSteps(GEN, [...GEN], 4)).toBeNull();
  });

  it('treats an absent current array as replaceable', () => {
    expect(nextTourSteps(undefined, GEN, 0)).toEqual(GEN);
  });

  /**
   * A same-length swap keeps every index valid but changes what the user is looking at,
   * so a length comparison alone is not enough.
   */
  it('refuses a same-length candidate that swaps a walked step', () => {
    const swapped = steps('gen:start', 'gen:terms', 'gen:remix');
    const original = steps('gen:start', 'gen:prompt', 'gen:remix');

    expect(nextTourSteps(original, swapped, 1)).toBeNull();
  });
});
