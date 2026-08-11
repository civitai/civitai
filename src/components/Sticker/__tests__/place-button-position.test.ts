import { describe, expect, it } from 'vitest';
import type { Box } from '~/components/Sticker/place-button-position';
import {
  flippedButtonOffset,
  placeButtonBoxes,
  shouldFlipPlaceButton,
} from '~/components/Sticker/place-button-position';

/** The real page at 1400x900: tray band, and the carousel viewport that clips. */
const TRAY: Box = { top: 760, bottom: 900, left: 0, right: 1400 };
const CLIP: Box = { top: 60, bottom: 846, left: 213, right: 737 };

const box = (top: number, height = 36, left = 600, right = 732): Box => ({
  top,
  bottom: top + height,
  left,
  right,
});

describe('flippedButtonOffset', () => {
  // The knob hangs `knobOffset` of the sticker's HEIGHT above it, so the
  // clearance has to scale with the sticker. A constant is what made the knob
  // dead at the default size, and a constant is what these cases forbid.
  it('scales with the sticker so the button clears the rotate knob', () => {
    expect(flippedButtonOffset({ stickerHeight: 100, knobOffset: 0.22, gap: 8 })).toBe(30);
    expect(flippedButtonOffset({ stickerHeight: 300, knobOffset: 0.22, gap: 8 })).toBe(74);
  });

  it('tracks the knob offset and the gap independently', () => {
    expect(flippedButtonOffset({ stickerHeight: 100, knobOffset: 0.5, gap: 8 })).toBe(58);
    expect(flippedButtonOffset({ stickerHeight: 100, knobOffset: 0.22, gap: 20 })).toBe(42);
  });

  it('clears the knob at every size in the measured dead band', () => {
    // The knob's top edge sits at -knobOffset*height in the sticker's own space;
    // the flipped button's bottom sits at -offset. Measured on the real page,
    // heights from ~73 to ~236 put the knob's centre inside the button.
    for (const stickerHeight of [73, 94, 150, 200, 236]) {
      const offset = flippedButtonOffset({ stickerHeight, knobOffset: 0.22, gap: 8 });
      expect(offset).toBeGreaterThan(0.22 * stickerHeight);
    }
  });
});

describe('placeButtonBoxes', () => {
  it('puts the alternative straight below at rotation 0', () => {
    const current = box(300);
    const { below, above } = placeButtonBoxes({
      current,
      flipped: true,
      rotationDeg: 0,
      distance: 252,
    });

    expect(above).toEqual(current);
    expect(below.top).toBeCloseTo(552);
    expect(below.bottom).toBeCloseTo(588);
  });

  it('inverts at 180 degrees, where the CSS "below" is above on screen', () => {
    // Measured in Chromium: a 200px sticker at rotate(180deg) put the unflipped
    // button at 309-345 and the flipped one at 561-597 — the opposite way round.
    const { below, above } = placeButtonBoxes({
      current: box(561),
      flipped: true,
      rotationDeg: 180,
      distance: 252,
    });

    expect(above.top).toBeCloseTo(561);
    expect(below.top).toBeCloseTo(309);
    expect(below.top).toBeLessThan(above.top);
  });

  it('gives the same pair whichever position the button is in', () => {
    // The property the whole design rests on: no feedback, so flipping cannot
    // remove its own cause. Same geometry, described from both sides.
    for (const rotationDeg of [0, 45, 90, 180, -135]) {
      const fromBelow = placeButtonBoxes({
        current: box(300),
        flipped: false,
        rotationDeg,
        distance: 252,
      });
      const fromAbove = placeButtonBoxes({
        current: fromBelow.above,
        flipped: true,
        rotationDeg,
        distance: 252,
      });

      expect(fromAbove.below.top).toBeCloseTo(fromBelow.below.top);
      expect(fromAbove.above.top).toBeCloseTo(fromBelow.above.top);
    }
  });

  it('moves sideways when the sticker is turned on its side', () => {
    const { below } = placeButtonBoxes({
      current: box(300),
      flipped: true,
      rotationDeg: 90,
      distance: 100,
    });

    expect(below.top).toBeCloseTo(300);
    expect(below.left).toBeCloseTo(500);
  });
});

describe('shouldFlipPlaceButton', () => {
  const decide = (below: Box, above: Box, tray: Box | null = TRAY, clip: Box | null = CLIP) =>
    shouldFlipPlaceButton({ below, above, tray, clip });

  it('leaves a button that is already visible alone', () => {
    expect(decide(box(400), box(200))).toBe(false);
  });

  it('flips a button the tray would cover', () => {
    expect(decide(box(730), box(400))).toBe(true);
  });

  it('flips a button the carousel would clip', () => {
    // Below the media box but above the tray band: invisible for the other
    // reason, and a tray-only test would leave it broken.
    const tallClip: Box = { top: 60, bottom: 500, left: 213, right: 737 };
    expect(decide(box(480), box(200), TRAY, tallClip)).toBe(true);
  });

  it('does not flip when the flipped position is also hidden', () => {
    // A sticker tall enough that both ends are in trouble. Flipping here moves
    // the button without fixing anything.
    expect(decide(box(800), box(730))).toBe(false);
  });

  it('does not flip a button off the top of the viewport', () => {
    expect(decide(box(800), box(-20))).toBe(false);
    expect(decide(box(800), box(70))).toBe(true);
  });

  it('does not flip when the sticker is beside the tray rather than above it', () => {
    const narrowTray: Box = { top: 760, bottom: 900, left: 500, right: 900 };
    const wideClip: Box = { top: 0, bottom: 900, left: 0, right: 1400 };
    expect(decide(box(780, 36, 100, 232), box(300, 36, 100, 232), narrowTray, wideClip)).toBe(
      false
    );
    expect(decide(box(780, 36, 600, 732), box(300, 36, 600, 732), narrowTray, wideClip)).toBe(true);
  });

  it('has nothing to say with neither a tray nor a clip', () => {
    expect(decide(box(800), box(300), null, null)).toBe(false);
  });
});
