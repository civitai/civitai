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
 * The left panel's width, derived rather than measured, because the count of
 * controls in it is what moves.
 *
 * A `size="sm"` `ActionIcon` is 22px, `gap-0.5` is 2px and `px-1` is 4px a side.
 * Duplicate, flip and opacity: `4 + 22 + 2 + 22 + 2 + 22 + 4`.
 *
 * 🔴 KEEP THIS IN STEP WITH THE PANEL'S JSX. The constant below was computed for
 * TWO icons and stayed at 124 when Copy was added as a third, so on every
 * sticker between 124px and 172px wide the panel reached past the rotate knob
 * and swallowed the press — the knob was visibly there and completely dead.
 */
const PANEL_LEFT_CONTROLS = 3;
const PANEL_ICON_PX = 22;
const PANEL_ICON_GAP_PX = 2;
const PANEL_PADDING_X_PX = 4;

export const STICKER_PANEL_LEFT_WIDTH_PX =
  PANEL_PADDING_X_PX * 2 +
  PANEL_LEFT_CONTROLS * PANEL_ICON_PX +
  (PANEL_LEFT_CONTROLS - 1) * PANEL_ICON_GAP_PX;

/** The rotate knob is `size-4`, centred on the top edge, so it reaches 8px each way. */
const KNOB_HALF_WIDTH_PX = 8;

/**
 * The narrowest sticker whose top edge can host both panels without the rotate
 * knob ending up underneath one.
 *
 * The knob spans `[w/2 - 8, w/2 + 8]` and the left panel reaches
 * `STICKER_PANEL_LEFT_WIDTH_PX` in from the left edge, so clear of each other
 * needs `w/2 - 8 >= left`. Below this there are no panels above the sticker at
 * all: the draft's controls move into the buy cluster, which measures its own
 * position against the tray and the clipping ancestor. Anchoring them to a small
 * sticker's box fails in both directions — inside it they reach past each other
 * and the knob, outside it they hang off the sticker and are clipped away near
 * the edges of the image.
 */
export const STICKER_PANEL_MIN_WIDTH_PX = (STICKER_PANEL_LEFT_WIDTH_PX + KNOB_HALF_WIDTH_PX) * 2;

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

/** The band to clear, which is nothing at all when no panels are drawn. */
export const panelBandFor = (stickerWidth: number) =>
  panelsFitInsideEdges(stickerWidth) ? STICKER_PANEL_BAND_PX : 0;

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
  panelBand,
}: {
  stickerHeight: number;
  knobOffset: number;
  gap: number;
  /**
   * Required, with no default. The whole bug class here was an obstacle nobody
   * accounted for, and a caller that forgets this would silently get the old
   * behaviour back — pass 0 deliberately if a surface truly has no panels.
   */
  panelBand: number;
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
