import { describe, expect, it } from 'vitest';
import { knobBelowFor, knobRotation } from '~/components/Sticker/draft-gesture';
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

describe('a knob hanging below the sticker', () => {
  // The knob points away from the sticker's top: hung below, it points at rotation + 180, so the
  // sticker turns to put its top opposite the pointer. Without this a grab snaps a half turn.
  it('reads the pointer as the opposite side', () => {
    expect(knobRotation(0, 1, true)).toBe(0);
    expect(knobRotation(-1, 0, true)).toBe(90);
    expect(knobRotation(1, 0, true)).toBe(-90);
    expect(knobRotation(0, -1, true)).toBe(-180);
  });
});

describe('knobBelowFor', () => {
  // A 100px-tall sticker: its knob's outer edge is 50 + 22 = 72px from the centre.
  const clip = { top: 0, left: 0, right: 400, bottom: 400 };
  const at = (x: number, y: number, rotation = 0, current = false) =>
    knobBelowFor({ centre: { x, y }, height: 100, rotation, knobOffset: 0.22, clip, current });

  it('keeps the knob above wherever it fits there', () => {
    expect(at(200, 200)).toBe(false);
    expect(at(200, 72)).toBe(false);
  });

  it('hangs it below at the top edge, where above is past the clip', () => {
    expect(at(200, 71)).toBe(true);
  });

  it('follows the rotation: turned a quarter, the knob points right, so the right edge flips it', () => {
    expect(at(340, 200, 90)).toBe(true);
    expect(at(340, 200, -90)).toBe(false);
  });

  it('stays below near the edge, so it does not swap back and forth there', () => {
    // Above would fit by 10px: inside the 24px return margin.
    expect(at(200, 82, 0, true)).toBe(true);
  });

  it('comes back above once the sticker is clear of the edge', () => {
    // A hat dragged from the top edge back to the middle.
    expect(at(200, 200, 0, true)).toBe(false);
  });

  it('comes back above when below no longer fits, even inside the return margin', () => {
    // A 150px-tall clip: above fits by 10px (inside the margin), below is 4px past the bottom.
    expect(
      knobBelowFor({
        centre: { x: 200, y: 82 },
        height: 100,
        rotation: 0,
        knobOffset: 0.22,
        clip: { top: 0, left: 0, right: 400, bottom: 150 },
        current: true,
      })
    ).toBe(false);
  });

  it('stays above when neither side fits', () => {
    expect(
      knobBelowFor({
        centre: { x: 200, y: 50 },
        height: 100,
        rotation: 0,
        knobOffset: 0.22,
        clip: { top: 0, left: 0, right: 400, bottom: 100 },
        current: false,
      })
    ).toBe(false);
  });
});
