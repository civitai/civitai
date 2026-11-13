import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { knobRotation } from '~/components/Sticker/draft-gesture';

/**
 * The rotation fix has two halves and only one of them is testable as a value.
 *
 * `knobRotation` wraps the knob's angle into the ±180 the draft store clamps to,
 * and `draft-gesture.test.ts` covers that thoroughly. The other half is
 * `useDraftGestures` **calling** it instead of inlining `atan2 + 90`. The hat
 * placement browser test drives the knob only to a quarter turn, where the
 * wrapped and unwrapped angles agree, so reverting that one line brings the bug
 * back (a knob past the half turn is clamped, not wrapped) while every other
 * test stays green.
 *
 * ⚠️ **What this is and is not.** It is a source guard: it reads the file and
 * checks which function the rotate branch calls. It catches the revert, which is
 * the failure that actually happened. It does **not** verify that the value
 * reaches the store, and it can be defeated by computing an unwrapped angle some
 * other way. The honest fix is a rendered test that drags the knob past the half
 * turn and reads the rotation back, which the placement browser test could do.
 * If someone writes it, delete this.
 */
const LAYER = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'components',
  'Sticker',
  'useDraftGestures.ts'
);

const source = fs.readFileSync(LAYER, 'utf8');

describe('the rotate gesture goes through knobRotation', () => {
  /**
   * 🔴 The negative control. A guard reading a file that has moved passes
   * forever and looks identical to one that checked something.
   */
  it('is reading the file it thinks it is', () => {
    expect(fs.existsSync(LAYER)).toBe(true);
    expect(source).toContain("active.mode === 'rotate'");
  });

  it('calls the wrapping helper rather than computing the angle inline', () => {
    expect(source).toContain('knobRotation(');
  });

  /**
   * The revert, spelled as it was written. `atan2` anywhere in this file is
   * either the inlined angle coming back or a second one that needs the same
   * treatment; both want a human to look.
   */
  it('computes no angle of its own', () => {
    expect(source).not.toMatch(/Math\.atan2/);
  });

  /**
   * Not redundant with `draft-gesture.test.ts`: that file asserts the helper's
   * values, this asserts the property the guard above exists to protect, so a
   * reader of this file can see what "wrapped" buys without leaving it.
   */
  it('names what the helper is for', () => {
    expect(knobRotation(-1, 0)).toBe(-90);
    expect(knobRotation(-1, 1)).toBeCloseTo(-135);
  });
});
