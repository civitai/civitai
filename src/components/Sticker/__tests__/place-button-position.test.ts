import { describe, expect, it } from 'vitest';
import type { Box } from '~/components/Sticker/place-button-position';
import {
  candidateDistance,
  flippedButtonOffset,
  panelBandFor,
  panelsFitInsideEdges,
  placeButtonBoxes,
  shouldFlipPlaceButton,
  STICKER_PANEL_BAND_PX,
  STICKER_PANEL_MIN_WIDTH_PX,
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
    expect(
      flippedButtonOffset({ stickerHeight: 100, knobOffset: 0.22, gap: 8, panelBand: 0 })
    ).toBe(30);
    expect(
      flippedButtonOffset({ stickerHeight: 300, knobOffset: 0.22, gap: 8, panelBand: 0 })
    ).toBe(74);
  });

  it('tracks the knob offset and the gap independently', () => {
    expect(flippedButtonOffset({ stickerHeight: 100, knobOffset: 0.5, gap: 8, panelBand: 0 })).toBe(
      58
    );
    expect(
      flippedButtonOffset({ stickerHeight: 100, knobOffset: 0.22, gap: 20, panelBand: 0 })
    ).toBe(42);
  });

  it('clears the knob at every size in the measured dead band', () => {
    // The knob's top edge sits at -knobOffset*height in the sticker's own space;
    // the flipped button's bottom sits at -offset. Measured on the real page,
    // heights from ~73 to ~236 put the knob's centre inside the button.
    for (const stickerHeight of [73, 94, 150, 200, 236]) {
      const offset = flippedButtonOffset({ stickerHeight, knobOffset: 0.22, gap: 8, panelBand: 0 });
      expect(offset).toBeGreaterThan(0.22 * stickerHeight);
    }
  });

  // The knob is not the only thing up there any more. The two control panels
  // occupy a band that does NOT scale with the sticker, so on a short one the
  // knob clearance is the smaller of the two and clearing only it puts the
  // button over the panels — where it paints last and swallows the pointer, so
  // flip, opacity and delete are visibly present and completely dead.
  it('clears the panel band on a sticker too short for the knob to be the obstacle', () => {
    // 72px: a 2:1 sticker at the DEFAULT 18% scale on an 800px media box. The
    // knob wants 15.8px of clearance and the panels want 36.
    const offset = flippedButtonOffset({
      stickerHeight: 72,
      knobOffset: 0.22,
      gap: 8,
      panelBand: STICKER_PANEL_BAND_PX,
    });

    expect(offset).toBeGreaterThan(STICKER_PANEL_BAND_PX);
    expect(offset).toBe(44);
  });

  it('still clears the knob once the sticker is tall enough for it to win', () => {
    const stickerHeight = 400;
    const offset = flippedButtonOffset({
      stickerHeight,
      knobOffset: 0.22,
      gap: 8,
      panelBand: STICKER_PANEL_BAND_PX,
    });

    expect(offset).toBeGreaterThan(0.22 * stickerHeight);
    expect(offset).toBe(96);
  });

  // Every height in the range a sticker can actually take, against BOTH
  // obstacles at once — the pair above pins the two regimes, this pins that
  // there is no gap between them.
  it('clears both obstacles across the whole scale range', () => {
    for (const stickerHeight of [20, 51, 72, 100, 127, 150, 236, 400]) {
      const offset = flippedButtonOffset({
        stickerHeight,
        knobOffset: 0.22,
        gap: 8,
        panelBand: STICKER_PANEL_BAND_PX,
      });

      expect(offset).toBeGreaterThan(0.22 * stickerHeight);
      expect(offset).toBeGreaterThan(STICKER_PANEL_BAND_PX);
    }
  });
});

describe('panelsFitInsideEdges', () => {
  // Flush with the edges is the intended look, and it is only safe while the
  // sticker is wide enough that the two panels cannot reach past each other —
  // the delete button paints last, so an overlap means it lands on the opacity
  // button and a misclick throws the draft away.
  it('refuses the flush layout on the sizes where delete would cover opacity', () => {
    // The 5% scale floor on a 1024px media box, and the default 18% on a
    // phone-width one. Both are states the product actually produces.
    expect(panelsFitInsideEdges(51)).toBe(false);
    expect(panelsFitInsideEdges(65)).toBe(false);
  });

  // The rotate knob is centred and 16px wide, and the left panel reaches 54px
  // in: below 124 the knob ends up under it, and the panel swallows the press.
  it('is bounded by the knob, not merely by the two panels touching', () => {
    expect(panelsFitInsideEdges(STICKER_PANEL_MIN_WIDTH_PX - 1)).toBe(false);
    expect(panelsFitInsideEdges(STICKER_PANEL_MIN_WIDTH_PX)).toBe(true);
    // 92 is where the panels alone stop overlapping (54 + 26 + a gap). Wide
    // enough for them, still too narrow for the knob — the case a fix aimed at
    // the panels alone would get wrong.
    expect(panelsFitInsideEdges(92)).toBe(false);
  });

  it('allows it at the sizes the flush layout was designed for', () => {
    expect(panelsFitInsideEdges(144)).toBe(true);
    expect(panelsFitInsideEdges(400)).toBe(true);
  });

  // The band exists only where the panels do. Clearing one that is not there is
  // not harmful in itself, but it shrinks the flipped candidate box and so makes
  // the button decline a flip it could have taken.
  it('reports no band to clear where no panels are drawn', () => {
    expect(panelBandFor(51)).toBe(0);
    expect(panelBandFor(144)).toBe(STICKER_PANEL_BAND_PX);
  });
});

describe('candidateDistance', () => {
  // A second line of copy under the Buzz button makes the wrapper taller. The
  // unflipped position moves down with it and the distance has to follow; the
  // flipped position does not move, because it is anchored by its bottom edge.
  it('grows with the button, one pixel for one pixel', () => {
    const base = { stickerHeight: 200, flippedOffset: 52, gap: 8 };
    expect(candidateDistance({ ...base, buttonHeight: 36 })).toBe(296);
    expect(candidateDistance({ ...base, buttonHeight: 52 })).toBe(312);
    expect(candidateDistance({ ...base, buttonHeight: 88 })).toBe(348);
  });

  it('tracks the sticker, the clearance and the gap independently', () => {
    const base = { stickerHeight: 200, buttonHeight: 36, flippedOffset: 52, gap: 8 };
    expect(candidateDistance({ ...base, stickerHeight: 300 })).toBe(396);
    expect(candidateDistance({ ...base, flippedOffset: 74 })).toBe(318);
    expect(candidateDistance({ ...base, gap: 20 })).toBe(308);
  });

  it('is the real gap between the two positions the CSS produces', () => {
    // Unflipped spans [H + gap, H + gap + button]; flipped spans
    // [-offset - button, -offset]. The distance is between matching edges.
    const stickerHeight = 94;
    const buttonHeight = 52;
    const gap = 8;
    const flippedOffset = flippedButtonOffset({
      stickerHeight,
      knobOffset: 0.22,
      gap,
      panelBand: 0,
    });

    const unflippedTop = stickerHeight + gap;
    const flippedTop = -flippedOffset - buttonHeight;

    expect(candidateDistance({ stickerHeight, buttonHeight, flippedOffset, gap })).toBeCloseTo(
      unflippedTop - flippedTop
    );
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

  it('decides on the whole wrapper, not on a one-line button', () => {
    // A single-line button clears the tray at this position; the two-line one
    // that lands with the merged copy does not.
    expect(decide(box(715, 36), box(400, 36))).toBe(false);
    expect(decide(box(715, 52), box(400, 52))).toBe(true);
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

  it('does not flip off the top of the viewport with no clip to catch it', () => {
    // The case above is satisfied by the clip check alone, because the carousel
    // starts at y=60. With no clipping ancestor — or one starting at the top of
    // the viewport — the viewport guard is the only thing left.
    expect(decide(box(800), box(-20), TRAY, null)).toBe(false);
    expect(decide(box(800), box(10), TRAY, null)).toBe(true);

    const fullHeightClip: Box = { top: 0, bottom: 900, left: 0, right: 1400 };
    expect(decide(box(800), box(-20), TRAY, fullHeightClip)).toBe(false);
  });

  it('flips away from the top edge of the clip, not just the bottom', () => {
    // Above the carousel viewport but still on screen: clipped at the top, which
    // nothing else would catch.
    expect(decide(box(800), box(20))).toBe(false);
    expect(decide(box(800), box(65))).toBe(true);
  });

  it('treats a button resting exactly on the tray edge as visible', () => {
    // Touching is not overlapping. Flipping here would move a button nobody is
    // having trouble seeing.
    expect(decide(box(724), box(400))).toBe(false);
    expect(decide(box(725), box(400))).toBe(true);
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
