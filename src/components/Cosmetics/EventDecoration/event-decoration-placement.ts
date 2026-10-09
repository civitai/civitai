import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';

/**
 * Where a hat sits on a card. Grids clip anything drawn more than ITEM_BLEED outside a card
 * (virtual masonry's paint containment, home-block overflow), so every placement is solved
 * backwards from that budget rather than tuned by eye.
 */
export type HatPlacement = 'corner' | 'top' | 'inside';
export const DEFAULT_HAT_PLACEMENT: HatPlacement = 'corner';


// Hat art is a 128x160 canvas, drawn upright, brim bottom-centre at (64, 150). These are the
// points its visible pixels can reach: the tip, and the brim's outer corners.
const CANVAS = { width: 128, height: 160 };
const ART_EXTREMES = [
  { x: 64, y: 0 },
  { x: 0, y: 128 },
  { x: 128, y: 128 },
  { x: 0, y: 156 },
  { x: 128, y: 156 },
];
const ANCHOR = { x: 64, y: 150 };

/** `overhang` is how far the visible hat reaches past the edge; negative keeps it inside. */
const PLACEMENTS: Record<HatPlacement, { width: number; rotateDeg: number; overhang: number }> = {
  corner: { width: 28, rotateDeg: -18, overhang: ITEM_BLEED },
  top: { width: 24, rotateDeg: 0, overhang: ITEM_BLEED },
  // For containers that clip at the card's edge with no bleed at all (carousels).
  inside: { width: 28, rotateDeg: -18, overhang: -4 },
};

/** The art's visible extremes, in px relative to its anchor, at this placement's size and tilt. */
function extremesAroundAnchor(placement: HatPlacement) {
  const { width, rotateDeg } = PLACEMENTS[placement];
  const scale = width / CANVAS.width;
  const rad = (rotateDeg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  return ART_EXTREMES.map(({ x, y }) => {
    const [dx, dy] = [(x - ANCHOR.x) * scale, (y - ANCHOR.y) * scale];
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  });
}

/**
 * The hat's box, in px from the card's top-left corner. `corner` leans out of the top-left
 * corner; `top` stands upright on the middle of the top edge; `inside` sits in the top-left
 * corner without leaving the card. The art reaches exactly its placement's overhang past the
 * edge it hangs off, and no further.
 */
export function getHatLayout(placement: HatPlacement) {
  const { width, rotateDeg, overhang } = PLACEMENTS[placement];
  const scale = width / CANVAS.width;
  const height = CANVAS.height * scale;
  const points = extremesAroundAnchor(placement);
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));

  const anchorY = -overhang - minY;
  // `top` is centred horizontally by CSS, so only its vertical position is solved here.
  const anchorX = placement === 'top' ? 0 : -overhang - minX;

  return {
    width,
    height,
    rotateDeg,
    /** Box position of the unrotated element; rotation is about the anchor (brim bottom-centre). */
    left: anchorX - ANCHOR.x * scale,
    top: anchorY - ANCHOR.y * scale,
    origin: `${ANCHOR.x * scale}px ${ANCHOR.y * scale}px`,
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
export function getEventDecorationClearLeft(type: string, placement = DEFAULT_HAT_PLACEMENT) {
  if (type !== 'hat' || placement === 'top') return 0;
  return Math.ceil(getHatLayout(placement).reach.right) + 4;
}
