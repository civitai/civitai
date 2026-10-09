import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import { constants } from '~/server/common/constants';
import { HAT_FIT_LIMITS } from '~/shared/constants/event-decoration.constants';
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
 * The card width the look was chosen on (a feed card, and PreviewCard's default). A smaller card
 * that passes its width wears the hat scaled down to match; no card wears it larger.
 */
export const HAT_LOOK_CARD_WIDTH = constants.cardSizes.image;

/** How much a hat shrinks on a card this wide: 1 for a feed card, a wider one, or no width. */
export function getHatCardScale(cardWidth?: number) {
  return isFiniteNumber(cardWidth) && cardWidth > 0
    ? Math.min(1, cardWidth / HAT_LOOK_CARD_WIDTH)
    : 1;
}

const within = ([lo, hi]: readonly [number, number], value: number) =>
  Math.min(hi, Math.max(lo, value));
// Not `isNumber` from ~/utils/type-guards: that one accepts '5' and null.
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * How much further up and left a hat sits on a card without a padded frame, in CSS px. The 6px
 * padding of a CSS or texture frame (TwCosmeticWrapper/CosmeticWrapper.module.scss) already
 * carries that card's hat out past the picture; this matches that look.
 */
export const HAT_PLAIN_CARD_NUDGE = 4;

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
 * every design is worn at the same size and none is cropped. On a card narrower than a feed card
 * (`cardWidth`), the size, nudge and offset shrink with it; the container's room does not.
 */
export function getHatLayout(
  placement: HatPlacement,
  fit?: EventDecorationFit,
  allowance = HAT_ALLOWANCE[placement],
  nudge = 0,
  cardWidth?: number
) {
  const cardScale = getHatCardScale(cardWidth);
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
  const brimWidth =
    (isFiniteNumber(fit?.size) && fit.size > 0
      ? within(HAT_FIT_LIMITS.size, fit.size)
      : HAT_LOOK.brim) * cardScale;
  const tilt = isFiniteNumber(fit?.tilt) ? within(HAT_FIT_LIMITS.tilt, fit.tilt) : HAT_LOOK.tilt;
  const depth = isFiniteNumber(fit?.depth)
    ? within(HAT_FIT_LIMITS.depth, fit.depth)
    : HAT_LOOK.onCard;
  const grow = isFiniteNumber(fit?.grow) ? within(HAT_FIT_LIMITS.grow, fit.grow) : HAT_LOOK.grow;
  const [offsetX, offsetY] = isNumbers(fit?.offset, 2)
    ? fit.offset.map((x) => within(HAT_FIT_LIMITS.offset, x) * cardScale)
    : [0, 0];
  const cardNudge = nudge * cardScale;

  const scale = brimWidth / (brimRight - brimLeft);
  const pivot = { x: (brimLeft + brimRight) / 2, y: brimY };
  const rad = (tilt * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];

  // The brim's middle sits on the line from the corner along the hat's lean, far enough in that
  // `depth` of the hat's height is inside the card.
  const heightAboveBrim = (brimY - Math.min(...outline.map(([, y]) => y))) * scale;
  const inset = depth * heightAboveBrim;
  const points = outline.map(([x, y]) => {
    const [dx, dy] = [(x - pivot.x) * scale, (y - pivot.y) * scale];
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  });
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));

  const pivotX = Math.max(-sin * inset - cardNudge + offsetX, -allowance - minX);
  const pivotY = Math.max(cos * inset - cardNudge + offsetY, -allowance - minY);

  return {
    width: canvasW * scale,
    height: canvasH * scale,
    tilt,
    /** Hover scale, about the brim. */
    grow,
    /** Box position of the unrotated element; rotation and hover growth are about the brim. */
    left: pivotX - pivot.x * scale,
    top: pivotY - pivot.y * scale,
    origin: `${pivot.x * scale}px ${pivot.y * scale}px`,
    /** The art's own outline (or its bounds), so clicks beside the hat reach what is under it. */
    hitArea: `polygon(${(
      artOutline ?? [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ]
    )
      .map(([x, y]) => `${x * scale}px ${y * scale}px`)
      .join(', ')})`,
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
 * How far a container with less room moves a corner hat in, as CSS: only CSS can read the
 * container's `--event-decoration-allowance`. `reach` is the hat's edge with no room limit.
 */
export const hatShiftCss = (reach: number) =>
  `max(0px, -1 * var(--event-decoration-allowance, ${HAT_ALLOWANCE.corner}px) - ${reach}px)`;

/**
 * How much of the card's top-left a decoration covers, for corner content (the moderator's
 * browsing-level chip, the creator's avatar) to step clear of.
 */
export function getEventDecorationClearLeft(
  decoration: { type: string; fit?: EventDecorationFit },
  placement = DEFAULT_HAT_PLACEMENT,
  allowance?: number,
  nudge = 0,
  cardWidth?: number
) {
  if (decoration.type !== 'hat') return 0;
  return (
    Math.ceil(getHatLayout(placement, decoration.fit, allowance, nudge, cardWidth).reach.right) + 4
  );
}

/** `--event-decoration-clear-left` for a card: follows a corner hat its container moves in. */
export function getEventDecorationClearLeftCss(
  decoration: { type: string; fit?: EventDecorationFit },
  placement = DEFAULT_HAT_PLACEMENT,
  nudge = 0,
  cardWidth?: number
) {
  if (decoration.type !== 'hat' || placement !== 'corner')
    return `${getEventDecorationClearLeft(decoration, placement, undefined, 0, cardWidth)}px`;
  const { reach } = getHatLayout('corner', decoration.fit, Infinity, nudge, cardWidth);
  return `calc(${Math.ceil(reach.right) + 4}px + ${hatShiftCss(reach.left)})`;
}

/** A moderator's unsaved edit to a hat's fit; `null` puts a field back to the default look. */
export type HatFitChanges = Partial<{
  [K in 'size' | 'tilt' | 'depth' | 'grow' | 'offset']: EventDecorationFit[K] | null;
}>;

/** The hat's fit with the unsaved changes applied: a cleared field falls back to the look. */
export function applyHatFitChanges(fit: EventDecorationFit | undefined, changes: HatFitChanges) {
  const next: EventDecorationFit = { ...fit };
  for (const [key, value] of Object.entries(changes) as [keyof HatFitChanges, unknown][]) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else Object.assign(next, { [key]: value });
  }
  return next;
}
