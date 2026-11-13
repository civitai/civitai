export type PeekToggleCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

/** Bottom-left last: on the detail view that is where Hat Turf draws its cone. */
const PREFERENCE: PeekToggleCorner[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];

/** An event hat is always worn in the media's top-left corner (`ImageMediaHat`). */
export const EVENT_HAT_CORNERS: PeekToggleCorner[] = ['top-left'];

export const PEEK_TOGGLE_CORNER_CLASS: Record<PeekToggleCorner, string> = {
  'top-right': 'right-2 top-2',
  'top-left': 'left-2 top-2',
  'bottom-right': 'right-2 bottom-2',
  'bottom-left': 'left-2 bottom-2',
};

/**
 * Fractions of the box around a corner that count as "near" it. The toggle is
 * about 150×44px, a pending sticker's controls hang below its centre, and a
 * pending sticker is drawn at `scale` ≈ 0.3 of the width, so a centre this close
 * is one the pill would cover.
 */
const NEAR_X = 0.5;
const NEAR_Y = 0.4;

const cornerPoint = (corner: PeekToggleCorner) => ({
  x: corner.endsWith('right') ? 1 : 0,
  y: corner.startsWith('bottom') ? 1 : 0,
});

/**
 * Which corner of the image the peek toggle goes in, given the centres
 * (fractions of the box) of the pending stickers it is drawn over and the
 * corners something else already draws in: the first free corner in preference
 * order with none of the stickers nearby, else the free corner farthest from the
 * nearest one.
 */
export function peekToggleCorner(
  pending: { x: number; y: number }[],
  taken: PeekToggleCorner[] = []
): PeekToggleCorner {
  const free = PREFERENCE.filter((corner) => !taken.includes(corner));
  const corners = free.length ? free : PREFERENCE;
  const clear = corners.find((corner) => {
    const c = cornerPoint(corner);
    return pending.every(({ x, y }) => Math.abs(x - c.x) >= NEAR_X || Math.abs(y - c.y) >= NEAR_Y);
  });
  if (clear) return clear;

  const nearest = (corner: PeekToggleCorner) => {
    const c = cornerPoint(corner);
    return Math.min(...pending.map(({ x, y }) => Math.hypot(x - c.x, y - c.y)));
  };
  return corners.reduce((best, corner) => (nearest(corner) > nearest(best) ? corner : best));
}
