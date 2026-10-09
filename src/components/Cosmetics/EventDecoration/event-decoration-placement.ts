import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';

/**
 * Where a hat sits on a card. `corner` is worn on the top-left corner of a feed card; `inside` is
 * the same hat kept within the card, for containers that clip at the card's edge (carousels).
 */
export type HatPlacement = 'corner' | 'inside';
export const DEFAULT_HAT_PLACEMENT: HatPlacement = 'corner';

/**
 * The worn look, chosen by eye on real feed cards. The hat leans along a line through the card's
 * corner, so the corner sits inside it like a head; `onCard` is the share of the hat's height
 * (brim to top) that sits inside the card. `grow` is the hover scale, about the brim.
 */
export const HAT_LOOK = { brim: 40, tilt: -45, onCard: 0.47, grow: 1.4 };

/**
 * How far past the card's top and left edges the hat may reach at rest. Containers crop whatever
 * a card paints further out (virtual masonry's paint containment, home blocks' overflow), so a
 * hat that would reach further is moved into the card until it fits. A container with less room
 * than the feed declares it as `--event-decoration-allowance` (see EventDecorationOverlay).
 */
export const HAT_ALLOWANCE: Record<HatPlacement, number> = { corner: ITEM_BLEED, inside: -2 };

// The art convention when a cosmetic says nothing about its own fit: a 128x160 canvas, hat drawn
// upright, nothing below y=156.
const DEFAULT_CANVAS: [number, number] = [128, 160];
const DEFAULT_BOUNDS: [number, number, number, number] = [0, 0, 128, 156];

const isNumbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The hat's box, in px from the card's top-left corner, rotated about the middle of its brim.
 * Sizing and the overhang solve use the art's own brim and outline when its fit gives them, so
 * every design is worn at the same size and none is cropped.
 */
export function getHatLayout(
  placement: HatPlacement,
  fit?: EventDecorationFit,
  allowance = HAT_ALLOWANCE[placement]
) {
  const [canvasW, canvasH] = isNumbers(fit?.canvas, 2) ? fit.canvas : DEFAULT_CANVAS;
  const [left, top, right, bottom] =
    isNumbers(fit?.bounds, 4) && fit.bounds[2] > fit.bounds[0] && fit.bounds[3] > fit.bounds[1]
      ? fit.bounds
      : DEFAULT_BOUNDS;
  const [brimLeft, brimRight, brimY] =
    isNumbers(fit?.brim, 3) && fit.brim[1] > fit.brim[0] ? fit.brim : [left, right, bottom];
  const artOutline =
    Array.isArray(fit?.outline) &&
    fit.outline.length >= 3 &&
    fit.outline.every((point) => isNumbers(point, 2))
      ? fit.outline
      : undefined;
  const outline = artOutline ?? [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ];
  const brimWidth = typeof fit?.size === 'number' && fit.size > 0 ? fit.size : HAT_LOOK.brim;
  const tilt =
    typeof fit?.tilt === 'number' && Number.isFinite(fit.tilt) ? fit.tilt : HAT_LOOK.tilt;

  const scale = brimWidth / (brimRight - brimLeft);
  const pivot = { x: (brimLeft + brimRight) / 2, y: brimY };
  const rad = (tilt * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];

  // The brim's middle sits on the line from the corner along the hat's lean, far enough in that
  // `onCard` of the hat's height is inside the card.
  const heightAboveBrim = (brimY - Math.min(...outline.map(([, y]) => y))) * scale;
  const inset = HAT_LOOK.onCard * heightAboveBrim;
  const points = outline.map(([x, y]) => {
    const [dx, dy] = [(x - pivot.x) * scale, (y - pivot.y) * scale];
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  });
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));

  const pivotX = Math.max(-sin * inset, -allowance - minX);
  const pivotY = Math.max(cos * inset, -allowance - minY);

  return {
    width: canvasW * scale,
    height: canvasH * scale,
    tilt,
    /** Box position of the unrotated element; rotation and hover growth are about the brim. */
    left: pivotX - pivot.x * scale,
    top: pivotY - pivot.y * scale,
    origin: `${pivot.x * scale}px ${pivot.y * scale}px`,
    /** The art's own outline, so clicks beside the hat reach whatever is under it. */
    hitArea:
      artOutline &&
      `polygon(${artOutline.map(([x, y]) => `${x * scale}px ${y * scale}px`).join(', ')})`,
    /** Visible extent on the card at rest, for whatever has to keep clear of the hat. */
    reach: {
      left: pivotX + minX,
      top: pivotY + minY,
      right: pivotX + maxX,
      bottom: pivotY + maxY,
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
  if (decoration.type !== 'hat') return 0;
  return Math.ceil(getHatLayout(placement, decoration.fit).reach.right) + 4;
}
