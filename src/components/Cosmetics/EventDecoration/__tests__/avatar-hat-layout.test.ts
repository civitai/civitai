import { describe, expect, it } from 'vitest';
import {
  AVATAR_HAT_LOOK,
  getAvatarHatLayout,
  HAT_LOOK,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';

// A canvas 100x120 whose brim runs from x 10 to 90 at y 100: brim middle (50, 100), 80 units wide.
const FIT = {
  canvas: [100, 120] as [number, number],
  brim: [10, 90, 100] as [number, number, number],
};

// Where the brim's middle lands, in px from the avatar's top-left: the rotation is about that point,
// so it is the unrotated box's origin offset plus its position.
function brimMiddle(layout: ReturnType<typeof getAvatarHatLayout>) {
  const [ox, oy] = layout.origin.split(' ').map((v) => parseFloat(v));
  return { x: layout.left + ox, y: layout.top + oy };
}

describe('getAvatarHatLayout', () => {
  it('rests the brim on the avatar circle, leaning out along the tilt', () => {
    const size = 100;
    const layout = getAvatarHatLayout(FIT, size);
    const r = size / 2;
    const rad = (AVATAR_HAT_LOOK.tilt * Math.PI) / 180;
    const at = brimMiddle(layout);
    expect(at.x).toBeCloseTo(r + AVATAR_HAT_LOOK.sit * r * Math.sin(rad), 6);
    expect(at.y).toBeCloseTo(r - AVATAR_HAT_LOOK.sit * r * Math.cos(rad), 6);
    expect(layout.tilt).toBe(AVATAR_HAT_LOOK.tilt);
  });

  it('sizes the brim as a share of the avatar, so a bigger avatar wears a bigger hat', () => {
    const small = getAvatarHatLayout(FIT, 40);
    const big = getAvatarHatLayout(FIT, 96);
    // canvas 100 units, brim 80 units: box width = canvas * (brim px / brim units)
    expect(small.width).toBeCloseTo((100 * AVATAR_HAT_LOOK.brim * 40) / 80, 6);
    expect(big.width).toBeCloseTo((100 * AVATAR_HAT_LOOK.brim * 96) / 80, 6);
  });

  it("carries a hat's own card fit over: its size and lean relative to the card look", () => {
    const tuned = getAvatarHatLayout(
      { ...FIT, size: HAT_LOOK.brim * 1.25, tilt: HAT_LOOK.tilt + 10 },
      100
    );
    const plain = getAvatarHatLayout(FIT, 100);
    expect(tuned.width).toBeCloseTo(plain.width * 1.25, 6);
    expect(tuned.tilt).toBe(AVATAR_HAT_LOOK.tilt + 10);
  });

  it('reports how far the hat reaches above the avatar, so a clipping container can make room', () => {
    // Bounds 0..100 x 0..100 with the brim on the bottom edge: an upright square hat at no lean.
    const square = {
      canvas: [100, 100] as [number, number],
      bounds: [0, 0, 100, 100] as [number, number, number, number],
    };
    const size = 100;
    const layout = getAvatarHatLayout(
      { ...square, tilt: HAT_LOOK.tilt - AVATAR_HAT_LOOK.tilt },
      size
    );
    expect(layout.tilt).toBe(0);
    // Upright, the art's top is one hat-height above the brim, whose middle sits `sit` of the radius
    // out from the centre along the avatar lean.
    const r = size / 2;
    const brimY = r - AVATAR_HAT_LOOK.sit * r * Math.cos((AVATAR_HAT_LOOK.tilt * Math.PI) / 180);
    const hatHeight = AVATAR_HAT_LOOK.brim * size;
    expect(layout.overhangTop).toBeCloseTo(hatHeight - brimY, 6);
    // A hat that ends below the avatar's top reports none.
    expect(getAvatarHatLayout({ ...square, bounds: [0, 99, 100, 100] }, size).overhangTop).toBe(0);
  });

  it('falls back to the default canvas without a fit, rather than drawing nothing', () => {
    const layout = getAvatarHatLayout(undefined, 64);
    expect(layout.width).toBeGreaterThan(0);
    expect(Number.isFinite(layout.left) && Number.isFinite(layout.top)).toBe(true);
  });
});
