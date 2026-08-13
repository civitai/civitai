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
 * The band above the sticker's top edge that the two control panels occupy, in
 * px, measured from the top edge: they hang 36px up (`-top-9`) and are 26px tall
 * (a 22px `ActionIcon` in 2px of padding).
 *
 * A CONSTANT, unlike everything else above the sticker — that is the whole
 * hazard. The knob and the flipped button are both sized as a fraction of the
 * sticker's height, so anything reasoning about "what is above the sticker" from
 * height alone silently misses these.
 */
export const STICKER_PANEL_BAND_PX = 36;

/**
 * The narrowest sticker whose top edge can host both panels without the rotate
 * knob ending up underneath one.
 *
 * The knob is centred on the top edge and 16px wide, so it spans
 * `[w/2 - 8, w/2 + 8]`; the left panel (two icons) reaches 54px in from the left
 * edge. Clear of each other needs `w/2 - 8 >= 54`. Below this, the panels go
 * outside the corners instead — where they can reach neither the knob nor each
 * other, whatever the sticker's size.
 */
export const STICKER_PANEL_MIN_WIDTH_PX = 124;

/**
 * Whether the panels can sit flush with the sticker's own edges.
 *
 * They are drawn against the edges by design, which reads as bracketing the box
 * — but on a narrow sticker the two panels reach past each other and the
 * DESTRUCTIVE one wins, because it paints last: the delete button lands on the
 * opacity button. At the 5% scale floor that is a 51px-wide sticker, and at the
 * default 18% on a phone-width media box it is 65px, so this is a default state
 * rather than an edge case.
 */
export const panelsFitInsideEdges = (stickerWidth: number) =>
  stickerWidth >= STICKER_PANEL_MIN_WIDTH_PX;

/**
 * How far above the sticker the flipped button sits.
 *
 * Not a constant: the rotate knob hangs `knobOffset` of the sticker's height
 * above it, so a fixed margin puts the button on top of the knob at every
 * middling sticker size — and because the button's wrapper stops the pointer
 * event, the knob goes dead rather than merely hidden. Measured on the real
 * page: at the default 18% scale the knob's centre was inside the button.
 *
 * `panelBand` is the second obstacle and does NOT scale with the sticker, so the
 * larger of the two is what has to be cleared. Clearing only the knob leaves the
 * button over the control panels on any sticker shorter than ~127px — where it
 * paints last and stops the pointer event, so flip, opacity and delete are all
 * visibly present and completely dead.
 */
export const flippedButtonOffset = ({
  stickerHeight,
  knobOffset,
  gap,
  panelBand = 0,
}: {
  stickerHeight: number;
  knobOffset: number;
  gap: number;
  panelBand?: number;
}) => Math.max(knobOffset * stickerHeight, panelBand) + gap;

/**
 * How far apart the two positions are, along the sticker's own axis.
 *
 * Reads the button's height rather than assuming one: the wrapper holds
 * whatever is under the Buzz button as well as the button itself, so a second
 * line of copy makes it taller and moves the unflipped position further down.
 * The flipped position is unaffected — it is anchored by its bottom edge, so a
 * taller button grows upwards, away from the knob it has to clear.
 */
export const candidateDistance = ({
  stickerHeight,
  buttonHeight,
  flippedOffset,
  gap,
}: {
  stickerHeight: number;
  buttonHeight: number;
  flippedOffset: number;
  gap: number;
}) => stickerHeight + gap + flippedOffset + buttonHeight;

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
