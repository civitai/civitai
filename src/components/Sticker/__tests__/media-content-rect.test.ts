import { describe, expect, test } from 'vitest';
import { mediaContentRect } from '../media-content-rect';

/**
 * The arithmetic behind the featured-feed misplacement.
 *
 * A placement is a fraction of the ARTWORK. Under `object-fit: cover` the
 * element is a hole the artwork is cropped into, so the two rectangles differ —
 * and the overlay was using the hole. The numbers below are the reported case:
 * a portrait image in a landscape-ish card, where the crop takes most of the
 * height and a sticker placed near the middle lands near the bottom.
 */
const PORTRAIT = { width: 1000, height: 2000 };
const CARD = { width: 450, height: 600 };

describe('object-fit: cover', () => {
  /**
   * 🔴 The bug, stated as an assertion about a sticker rather than a rectangle.
   *
   * The card is the same box either way, so a test that only compared rects
   * could be read as "the numbers changed". What matters is that a placement at
   * y = 0.5 does not sit halfway down the CARD, because half the artwork is not
   * where half the card is.
   */
  test('a placement in the middle of the artwork is not the middle of the card', () => {
    const drawn = mediaContentRect({
      box: CARD,
      natural: PORTRAIT,
      fit: 'cover',
      position: '50% 0%',
    });

    // Scaled to cover 450 wide: 1000 -> 450 is 0.45, so 2000 -> 900.
    expect(drawn).toEqual({ width: 450, height: 900, left: 0, top: 0 });

    // Where the middle of the artwork actually falls inside the card.
    const middleOfArtwork = drawn.top + drawn.height * 0.5;
    expect(middleOfArtwork).toBe(450);

    // The card is 600 tall, so the old behaviour put it at 300 — 150px too high,
    // a quarter of the card. That gap is the whole bug.
    expect(middleOfArtwork).not.toBe(CARD.height * 0.5);
  });

  test('centres the overflow when object-position says so', () => {
    const drawn = mediaContentRect({
      box: CARD,
      natural: PORTRAIT,
      fit: 'cover',
      position: '50% 50%',
    });

    // 900 tall in a 600 box: 300 of overflow, half of it above.
    expect(drawn).toEqual({ width: 450, height: 900, left: 0, top: -150 });
  });

  test('crops the sides when the artwork is the wider one', () => {
    const drawn = mediaContentRect({
      box: CARD,
      natural: { width: 2000, height: 1000 },
      fit: 'cover',
      position: '50% 50%',
    });

    // Covers 600 tall: scale 0.6, so 2000 -> 1200 wide, 375 of overflow either
    // side of a 450 box.
    expect(drawn).toEqual({ width: 1200, height: 600, left: -375, top: 0 });
  });
});

describe('the fits that are not cover', () => {
  test('contain letterboxes rather than cropping', () => {
    const drawn = mediaContentRect({
      box: CARD,
      natural: PORTRAIT,
      fit: 'contain',
      position: '50% 50%',
    });

    // 600 tall is the binding side: scale 0.3, so 1000 -> 300 wide, centred.
    expect(drawn).toEqual({ width: 300, height: 600, left: 75, top: 0 });
  });

  test('fill draws to the box, which is what every uncropped surface does', () => {
    expect(
      mediaContentRect({ box: CARD, natural: PORTRAIT, fit: 'fill', position: '50% 50%' })
    ).toEqual({ ...CARD, left: 0, top: 0 });
  });

  test('scale-down never enlarges a small image', () => {
    const drawn = mediaContentRect({
      box: CARD,
      natural: { width: 100, height: 100 },
      fit: 'scale-down',
      position: '50% 50%',
    });

    expect(drawn).toEqual({ width: 100, height: 100, left: 175, top: 250 });
  });
});

describe('what it refuses to guess', () => {
  /**
   * An unloaded image reports 0x0. Scaling by that produces `Infinity` and then
   * `NaN` offsets, which reach the DOM as a style of `NaNpx` — the overlay
   * disappears rather than being merely misplaced, so this is the one input that
   * must not be computed from.
   */
  test('an unloaded image gets the element box, not NaN', () => {
    for (const natural of [null, { width: 0, height: 0 }, { width: 1000, height: 0 }])
      expect(mediaContentRect({ box: CARD, natural, fit: 'cover', position: '50% 50%' })).toEqual({
        ...CARD,
        left: 0,
        top: 0,
      });
  });

  test('keywords still resolve if a browser hands them back unresolved', () => {
    const drawn = mediaContentRect({
      box: CARD,
      natural: PORTRAIT,
      fit: 'cover',
      position: 'center bottom',
    });

    // Bottom-aligned: the whole 300 of overflow is above.
    expect(drawn.top).toBe(-300);
  });

  test('a pixel offset is an offset, not a proportion', () => {
    const drawn = mediaContentRect({
      box: CARD,
      natural: PORTRAIT,
      fit: 'cover',
      position: '0px -20px',
    });

    expect(drawn).toEqual({ width: 450, height: 900, left: 0, top: -20 });
  });
});
