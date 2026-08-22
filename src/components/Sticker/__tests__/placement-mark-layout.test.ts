import { describe, expect, it } from 'vitest';
import { placementMarkLayout } from '~/components/Sticker/placement-mark-layout';

/**
 * A power-of-two box throughout, deliberately: `y` is a FRACTION, so a boundary
 * case only lands on the boundary if `y * box.height` is exact. On the 886px
 * detail box the natural flush value comes out at 31.999999999999996 — close
 * enough that the assertion still passes, and close enough that a `<=`→`<`
 * mutant survives at one edge while being caught at the other.
 */
const BOX = { width: 1024, height: 1024 };
const STICKER = 128;
const MARK = 17;
const INSET = 4;
const GAP = 2;

const layout = (y: number, over: Partial<Parameters<typeof placementMarkLayout>[0]> = {}) =>
  placementMarkLayout({
    y,
    stickerHeight: STICKER,
    rotation: 0,
    markHeight: MARK,
    inset: INSET,
    gap: GAP,
    box: BOX,
    hasFree: true,
    hasPending: true,
    ...over,
  });

/** The `y` that puts the sticker's own top edge this far past the box's top. */
const topEdgePast = (px: number) => (STICKER / 2 - px) / BOX.height;
const bottomEdgePast = (px: number) => (BOX.height + px - STICKER / 2) / BOX.height;

describe('placementMarkLayout', () => {
  it('keeps each mark on its own edge in the middle of the image', () => {
    expect(layout(0.5)).toEqual({ free: 'top', pending: 'bottom' });
  });

  it('leaves a partly cropped mark where it is', () => {
    // 18px past the top: the mark spans -14..3, so 3px of it still reads.
    // Cropping with the artwork is the intended behaviour.
    expect(layout(topEdgePast(18)).free).toBe('top');
    expect(layout(bottomEdgePast(18)).pending).toBe('bottom');
  });

  it('flips a mark to the other edge once its own edge is entirely outside', () => {
    expect(layout(topEdgePast(25))).toEqual({ free: 'bottom', pending: 'bottom' });
    expect(layout(bottomEdgePast(25))).toEqual({ free: 'top', pending: 'top' });
  });

  it('is exact at the boundary — a mark flush with the edge has gone', () => {
    // `topEdgePast` counts pixels OUTSIDE the box, so a larger `y` pulls the
    // sticker back in — hence `+ 1 / height` here and `- 1 / height` below.
    const flushTop = topEdgePast(INSET + MARK);
    expect(layout(flushTop).free).toBe('bottom');
    expect(layout(flushTop + 1 / BOX.height).free).toBe('top');

    const flushBottom = bottomEdgePast(INSET + MARK);
    expect(layout(flushBottom).pending).toBe('top');
    expect(layout(flushBottom - 1 / BOX.height).pending).toBe('bottom');
  });

  it('moves neither mark when the sticker covers both edges', () => {
    // Every position is equally cropped, so a flip would only trade one gone
    // edge for another.
    expect(layout(0.5, { stickerHeight: BOX.height * 4 })).toEqual({
      free: 'top',
      pending: 'bottom',
    });
  });

  describe('rotation', () => {
    /**
     * 🔴 The marks are anchored in the sticker's OWN rotated frame, so a side
     * decided in screen space and applied there is inverted past ±90°. Without
     * the projection these cases move a fully visible mark off-image.
     */
    it('flips the mark that is really off-image, not the one named top', () => {
      // Upside down: the sticker's local top renders at the screen BOTTOM, so
      // the local-bottom mark is the one that has left the top of the image.
      const y = topEdgePast(25);
      expect(layout(y, { rotation: 180 })).toEqual({ free: 'top', pending: 'top' });
      // Same sticker the right way up flips the other one.
      expect(layout(y, { rotation: 0 })).toEqual({ free: 'bottom', pending: 'bottom' });
    });

    it('does not flip at ±90, where neither edge is the one being cropped', () => {
      const y = topEdgePast(25);
      expect(layout(y, { rotation: 90 })).toEqual({ free: 'top', pending: 'bottom' });
      expect(layout(y, { rotation: -90 })).toEqual({ free: 'top', pending: 'bottom' });
    });

    it('shrinks the reach as the sticker tilts', () => {
      // At 60° the local edges project to half their distance, so a sticker
      // whose upright top edge is gone still has its tilted one in frame.
      const y = topEdgePast(25);
      expect(layout(y, { rotation: 0 }).free).toBe('bottom');
      expect(layout(y, { rotation: 60 }).free).toBe('top');
    });
  });

  describe('room', () => {
    it('draws nothing on a sticker too short to hold both marks', () => {
      // Two marks need 2×17 + 2×4 + 2 = 44px.
      expect(layout(0.5, { stickerHeight: 43 })).toEqual({ free: null, pending: null });
      expect(layout(0.5, { stickerHeight: 44 })).toEqual({ free: 'top', pending: 'bottom' });
    });

    it('needs less room for one mark than for two', () => {
      const oneMark = { hasPending: false, stickerHeight: 30 };
      expect(layout(0.5, oneMark)).toEqual({ free: 'top', pending: null });
      expect(layout(0.5, { ...oneMark, hasPending: true })).toEqual({ free: null, pending: null });
    });

    it('asks for nothing when neither mark applies', () => {
      expect(layout(0.5, { hasFree: false, hasPending: false })).toEqual({
        free: null,
        pending: null,
      });
    });
  });

  it('draws nothing until the sticker and the box have been measured', () => {
    expect(layout(0.02, { box: { width: 0, height: 0 } })).toEqual({ free: null, pending: null });
    expect(layout(0.02, { stickerHeight: 0 })).toEqual({ free: null, pending: null });
    expect(layout(0.02, { markHeight: 0 })).toEqual({ free: null, pending: null });
  });
});
