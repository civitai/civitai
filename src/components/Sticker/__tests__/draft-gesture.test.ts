import { describe, expect, it } from 'vitest';
import { knobRotation } from '~/components/Sticker/draft-gesture';
import { STICKER_PLACEMENT_MAX_ROTATION } from '~/shared/utils/sticker-placement';

/**
 * The reported bug, stated as geometry: the pointer is BELOW and LEFT of the
 * sticker's centre — a counterclockwise drag past a quarter turn — and the
 * sticker has to follow it.
 *
 * Without the wrap these all come out between 180 and 270, and the draft store
 * clamps rotation to ±180, so every one of them lands on exactly 180: the
 * sticker snaps to a half turn and will not go further counterclockwise however
 * far the knob is dragged. The assertions below name the angle rather than
 * merely checking the range, so a revert reads as `expected 180 to be -90`.
 */
describe('knobRotation', () => {
  // Screen coordinates: +y is DOWN. dx/dy are the pointer's offset from the
  // sticker's centre, and the knob hangs above the sticker, so straight up is 0.
  it('reads the four cardinal directions off the knob', () => {
    expect(knobRotation(0, -1)).toBe(0);
    expect(knobRotation(1, 0)).toBe(90);
    // The half turn comes out at the -180 end of the range rather than the +180
    // one. Same rotation, and the range has to close somewhere.
    expect(knobRotation(0, 1)).toBe(-180);
    // Unwrapped this is 270, which the store clamps to 180 — the half turn
    // again, so the sticker cannot tell a quarter turn counterclockwise from
    // upside down.
    expect(knobRotation(-1, 0)).toBe(-90);
  });

  it('follows a counterclockwise drag past a quarter turn', () => {
    expect(knobRotation(-1, 1)).toBeCloseTo(-135);
    expect(knobRotation(-1, -1)).toBeCloseTo(-45);
  });

  /**
   * The property the clamp depends on, over a whole revolution rather than the
   * handful of points above: nothing this returns may reach the clamp, because
   * a clamped angle is a rotation the pointer is not at.
   */
  it('never returns an angle the store would clamp', () => {
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const radians = (degrees * Math.PI) / 180;
      const rotation = knobRotation(Math.cos(radians), Math.sin(radians));

      expect(rotation).toBeGreaterThanOrEqual(-STICKER_PLACEMENT_MAX_ROTATION);
      expect(rotation).toBeLessThanOrEqual(STICKER_PLACEMENT_MAX_ROTATION);
    }
  });
});
