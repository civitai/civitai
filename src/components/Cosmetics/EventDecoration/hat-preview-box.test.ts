import { describe, expect, it } from 'vitest';
import {
  getHatPreviewBox,
  HAT_PREVIEW,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';

// Bounds copied from prod birthday hats (128x160 files).
const TINY_UFO: EventDecorationFit = { canvas: [128, 160], bounds: [10, 83, 118, 152] };
const CHEETAH_BEANIE: EventDecorationFit = { canvas: [128, 160], bounds: [0, 22, 128, 152] };
const STRAW_HAT: EventDecorationFit = { canvas: [128, 160], bounds: [0, 73, 128, 152] };
const CIVBOT_RIDER: EventDecorationFit = { canvas: [128, 160], bounds: [16, 9, 112, 152] };
// Art off-centre in its file.
const SCAVENGER_HOOD: EventDecorationFit = { canvas: [128, 160], bounds: [0, 39, 102, 152] };
const MORNING_MUG: EventDecorationFit = { canvas: [128, 160], bounds: [24, 23, 128, 152] };
// Extreme shapes where the area rule alone would overflow the square.
const SLAB: EventDecorationFit = { canvas: [128, 160], bounds: [0, 140, 128, 152] };
const POLE: EventDecorationFit = { canvas: [128, 160], bounds: [60, 0, 68, 152] };
const LARGE_FILE: EventDecorationFit = { canvas: [384, 384], bounds: [58, 1, 326, 383] };

/** Where the art's visible pixels land in the square, as shares of its side. */
function visible(fit: EventDecorationFit) {
  const box = getHatPreviewBox(fit);
  if (!box || !fit.bounds || !fit.canvas) throw new Error('expected a box');
  const scale = box.width / fit.canvas[0];
  const [left, top, right, bottom] = fit.bounds;
  return {
    left: box.left + left * scale,
    top: box.top + top * scale,
    right: box.left + right * scale,
    bottom: box.top + bottom * scale,
    scale,
    box,
  };
}
const area = (v: ReturnType<typeof visible>) => (v.right - v.left) * (v.bottom - v.top);

describe('a hat preview sized by its art', () => {
  it('gives a flat hat and a tall one the same visible area', () => {
    const ufo = visible(TINY_UFO);
    const beanie = visible(CHEETAH_BEANIE);
    expect(Math.sqrt(area(ufo))).toBeCloseTo(HAT_PREVIEW.area, 9);
    expect(Math.sqrt(area(beanie))).toBeCloseTo(HAT_PREVIEW.area, 9);
    expect(ufo.scale / beanie.scale).toBeCloseTo(Math.sqrt((128 * 130) / (108 * 69)), 9);
  });

  it.each([
    ['Tiny UFO', TINY_UFO],
    ['Cheetah Propeller Beanie', CHEETAH_BEANIE],
    ['Straw Hat', STRAW_HAT],
    ['CivBot Rider', CIVBOT_RIDER],
    ['Scavenger Hood', SCAVENGER_HOOD],
    ['Morning Mug', MORNING_MUG],
    ['a slab', SLAB],
    ['a pole', POLE],
    ['a larger file', LARGE_FILE],
  ])('keeps %s whole and centred in the square', (_, fit) => {
    const v = visible(fit);
    const margin = (1 - HAT_PREVIEW.max) / 2;
    expect(v.left).toBeGreaterThanOrEqual(margin - 1e-9);
    expect(v.top).toBeGreaterThanOrEqual(margin - 1e-9);
    expect(v.right).toBeLessThanOrEqual(1 - margin + 1e-9);
    expect(v.bottom).toBeLessThanOrEqual(1 - margin + 1e-9);
    expect((v.left + v.right) / 2).toBeCloseTo(0.5, 9);
    expect((v.top + v.bottom) / 2).toBeCloseTo(0.5, 9);
    expect(v.box.height / v.box.width).toBeCloseTo(fit.canvas![1] / fit.canvas![0], 9);
  });

  it('fills the square edge to edge for a shape that would otherwise leave it', () => {
    const slab = visible(SLAB);
    const pole = visible(POLE);
    expect(slab.right - slab.left).toBeCloseTo(HAT_PREVIEW.max, 9);
    expect(pole.bottom - pole.top).toBeCloseTo(HAT_PREVIEW.max, 9);
  });

  it.each([
    ['no fit', undefined],
    ['a fit without bounds', { size: 44 }],
    ['bounds with no area', { bounds: [10, 10, 10, 50] }],
    ['bounds that are not numbers', { bounds: ['0', 0, 128, 152] }],
    ['a fit that is not an object', 'large'],
  ])('leaves the canvas sizing to the caller for %s', (_, fit) => {
    expect(getHatPreviewBox(fit as EventDecorationFit | undefined)).toBeUndefined();
  });

  it.each([[[0, 0]], [[128, 0]], [[0, 160]], [[128, -5]]] as [number, number][][])(
    'reads canvas %j as the 128x160 convention, not as an invisible hat',
    (canvas) => {
      const box = getHatPreviewBox({ canvas, bounds: TINY_UFO.bounds });
      expect(box).toEqual(getHatPreviewBox({ bounds: TINY_UFO.bounds }));
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    }
  );
});
