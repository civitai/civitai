import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';

/**
 * Where a hat sits on a card. Grids clip anything drawn more than ITEM_BLEED outside a card
 * (virtual masonry's paint containment, home-block overflow), so every placement is solved
 * backwards from that budget rather than tuned by eye.
 */
export type HatPlacement = 'corner' | 'top' | 'inside';
export const DEFAULT_HAT_PLACEMENT: HatPlacement = 'corner';

/**
 * `size` is the longer side of the hat's visible pixels, in CSS px. `overhang` is how far those
 * pixels reach past the edge they hang off; negative keeps the hat inside the card.
 */
const PLACEMENTS: Record<HatPlacement, { size: number; tilt: number; overhang: number }> = {
  corner: { size: 34, tilt: -18, overhang: ITEM_BLEED },
  top: { size: 30, tilt: 0, overhang: ITEM_BLEED },
  // For containers that clip at the card's edge with no bleed at all (carousels).
  inside: { size: 34, tilt: -18, overhang: -4 },
};

// The art convention when a cosmetic says nothing about its own fit: a 128x160 canvas, hat drawn
// upright, nothing below y=156.
const DEFAULT_CANVAS: [number, number] = [128, 160];
const DEFAULT_BOUNDS: [number, number, number, number] = [0, 0, 128, 156];

const isNumbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The hat's box, in px from the card's top-left corner. `corner` leans out of the top-left
 * corner; `top` stands upright on the middle of the top edge; `inside` sits in the top-left
 * corner without leaving the card. The art's visible pixels reach exactly the placement's
 * overhang past the edge, whatever its shape, because the solve uses the art's own bounds.
 */
export function getHatLayout(placement: HatPlacement, fit?: EventDecorationFit) {
  const defaults = PLACEMENTS[placement];
  const [canvasW, canvasH] = isNumbers(fit?.canvas, 2) ? fit.canvas : DEFAULT_CANVAS;
  const [left, top, right, bottom] =
    isNumbers(fit?.bounds, 4) && fit.bounds[2] > fit.bounds[0] && fit.bounds[3] > fit.bounds[1]
      ? fit.bounds
      : DEFAULT_BOUNDS;
  const size = typeof fit?.size === 'number' && fit.size > 0 ? fit.size : defaults.size;
  const tilt = placement !== 'top' && typeof fit?.tilt === 'number' ? fit.tilt : defaults.tilt;

  const scale = size / Math.max(right - left, bottom - top);
  // The hat rests on its bottom-centre: that is the point that sits on the card.
  const anchor = { x: (left + right) / 2, y: bottom };

  const rad = (tilt * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  const points = [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ].map(([x, y]) => {
    const [dx, dy] = [(x - anchor.x) * scale, (y - anchor.y) * scale];
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  });
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));

  const anchorY = -defaults.overhang - minY;
  // `top` is centred horizontally by CSS, so only its vertical position is solved here.
  const anchorX = placement === 'top' ? 0 : -defaults.overhang - minX;

  return {
    width: canvasW * scale,
    height: canvasH * scale,
    tilt,
    /** Box position of the unrotated element; rotation is about the anchor. */
    left: anchorX - anchor.x * scale,
    top: anchorY - anchor.y * scale,
    origin: `${anchor.x * scale}px ${anchor.y * scale}px`,
    /** Visible extent on the card, for whatever has to keep clear of the hat. */
    reach: {
      left: anchorX + minX,
      top: anchorY + minY,
      right: anchorX + maxX,
      bottom: anchorY + maxY,
    },
  };
}

/**
 * How much of the card's top-left a decoration covers, for corner content (the moderator's
 * browsing-level chip, the creator's avatar) to step clear of. Exposed to CSS as
 * `--event-decoration-clear-left`.
 */
export function getEventDecorationClearLeft(
  decoration: { type: string; fit?: EventDecorationFit },
  placement = DEFAULT_HAT_PLACEMENT
) {
  if (decoration.type !== 'hat' || placement === 'top') return 0;
  return Math.ceil(getHatLayout(placement, decoration.fit).reach.right) + 4;
}
