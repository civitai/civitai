/** The parts of a `DOMRect` this needs, so the geometry is testable without a DOM. */
export type Box = { top: number; bottom: number; left: number; right: number };

const overlaps = (a: Box, b: Box) =>
  a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;

const shift = (box: Box, dx: number, dy: number): Box => ({
  top: box.top + dy,
  bottom: box.bottom + dy,
  left: box.left + dx,
  right: box.right + dx,
});

/**
 * How far above the sticker the flipped button sits.
 *
 * Not a constant: the rotate knob hangs `knobOffset` of the sticker's height
 * above it, so a fixed margin puts the button on top of the knob at every
 * middling sticker size — and because the button's wrapper stops the pointer
 * event, the knob goes dead rather than merely hidden. Measured on the real
 * page: at the default 18% scale the knob's centre was inside the button.
 */
export const flippedButtonOffset = ({
  stickerHeight,
  knobOffset,
  gap,
}: {
  stickerHeight: number;
  knobOffset: number;
  gap: number;
}) => knobOffset * stickerHeight + gap;

/**
 * The two places the button can be, both as screen boxes.
 *
 * The button is a child of the sticker's rotated element, so "below" is only
 * below on screen at rotation 0 — at 180° the same CSS puts it *above*, and
 * reasoning about `top`/`bottom` without accounting for that inverts the whole
 * decision. Both boxes therefore come from the button's real measured rect, with
 * the alternative derived by rotating the local offset between the two
 * positions into screen space.
 *
 * Deriving the pair this way is also what keeps the decision free of feedback:
 * the same two boxes come out whichever position the button is currently in, so
 * flipping can never remove the condition that caused it and start oscillating.
 */
export function placeButtonBoxes({
  current,
  flipped,
  rotationDeg,
  distance,
}: {
  current: Box;
  flipped: boolean;
  rotationDeg: number;
  distance: number;
}): { below: Box; above: Box } {
  const radians = (rotationDeg * Math.PI) / 180;
  // The local vector from the flipped position to the unflipped one is (0, +d)
  // — straight down the sticker's own axis — rotated into screen space.
  const dx = -Math.sin(radians) * distance;
  const dy = Math.cos(radians) * distance;

  return flipped
    ? { above: current, below: shift(current, dx, dy) }
    : { below: current, above: shift(current, -dx, -dy) };
}

/**
 * Whether the buy button belongs above the sticker rather than below it.
 *
 * Two different things hide it, and both were measured on the image detail page
 * at 1400x900: the tray is `fixed` at `z-30` and paints over the whole sticker
 * overlay, and the carousel's viewport is `overflow: hidden` ending exactly at
 * the bottom of the media box (846px), which clips anything hanging below it.
 * A button can hit either without the other, so both are checked.
 *
 * Flips only when that strictly helps. A sticker low on a short viewport can
 * have nowhere good to put the button, and moving it to a second bad position
 * is worse than leaving it where the user last saw it.
 */
export function shouldFlipPlaceButton({
  below,
  above,
  tray,
  clip,
  viewportTop = 0,
}: {
  below: Box;
  above: Box;
  tray: Box | null;
  clip: Box | null;
  viewportTop?: number;
}) {
  const hidden = (box: Box) =>
    box.top < viewportTop ||
    (!!tray && overlaps(box, tray)) ||
    (!!clip && (box.bottom > clip.bottom || box.top < clip.top));

  return hidden(below) && !hidden(above);
}
