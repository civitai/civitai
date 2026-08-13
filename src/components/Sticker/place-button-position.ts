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
 * edge. Clear of each other needs `w/2 - 8 >= 54`. Below this there are no
 * panels above the sticker at all: the draft's controls move into the buy
 * cluster, which measures its own position against the tray and the clipping
 * ancestor. Anchoring them to a small sticker's box fails in both directions —
 * inside it they reach past each other and the knob, outside it they hang off
 * the sticker and are clipped away near the edges of the image.
 */
export const STICKER_PANEL_MIN_WIDTH_PX = 124;

/**
 * The width a draft that already has flush panels has to fall BELOW before they
 * are taken away again, 8px under the width it had to reach to get them.
 *
 * The two layouts are in different places in the component tree, so every
 * crossing of a single threshold unmounts one and mounts the other. A monotonic
 * drag crosses once and is fine; what a band buys is the NON-monotonic case,
 * where the width itself moves back and forth across the line — a corner-resize
 * gesture held near it, or a window-resize drag doing the same to the media box
 * the sticker's width is a percentage of. Each wobble is a full swap without it.
 *
 * It buys jitter resistance and nothing else: one deliberate crossing still
 * swaps the layouts, so anything stateful up there has to survive that on its
 * own rather than by being crossed less often.
 */
export const STICKER_PANEL_LEAVE_WIDTH_PX = 116;

/**
 * Whether the panels can sit flush with the sticker's own edges.
 *
 * They are drawn against the edges by design, which reads as bracketing the box
 * — but on a narrow sticker the two panels reach past each other and the
 * DESTRUCTIVE one wins, because it paints last: the delete button lands on the
 * opacity button. At the 5% scale floor that is a 51px-wide sticker, and at the
 * default 18% on a phone-width media box it is 65px, so this is a default state
 * rather than an edge case.
 *
 * `currentlyInside` is required, with no default, for the same reason
 * `flippedButtonOffset` demands its band: a caller that forgets it would get a
 * single threshold back and nothing would say so.
 */
export const panelsFitInsideEdges = (stickerWidth: number, currentlyInside: boolean) =>
  stickerWidth >= (currentlyInside ? STICKER_PANEL_LEAVE_WIDTH_PX : STICKER_PANEL_MIN_WIDTH_PX);

/** The band to clear, which is nothing at all when no panels are drawn. */
export const panelBandFor = (stickerWidth: number, currentlyInside: boolean) =>
  panelsFitInsideEdges(stickerWidth, currentlyInside) ? STICKER_PANEL_BAND_PX : 0;

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
 * at 1400x900: the tray is `fixed` at `z-30` over the whole sticker overlay, and
 * the carousel's viewport is `overflow: hidden` ending exactly at the bottom of
 * the media box (846px), which clips anything hanging below it. A button can hit
 * either without the other, so both are checked.
 *
 * The tray's rect is where the button cannot be PRESSED, which is deliberately
 * wider than what the tray paints: its root spans the viewport and hit-tests
 * across all of it, so the transparent gutters either side of the visible card
 * swallow a click just as thoroughly as the card does. Read it as painting and
 * the gutters look like slack worth trimming; they are not, and the ranking
 * below depends on the difference.
 *
 * Takes the visible side when there is one, and otherwise the LESS hidden of the
 * two. Standing still when both are bad reads as conservative and is not: on a
 * narrow draft the cluster carries the only copy of flip, opacity and delete, so
 * a button nobody can see is a draft with no controls at all until it is dragged
 * somewhere else. Ranking is free of feedback for the same reason the pair is:
 * both boxes come out identical whichever side the button is currently on, so a
 * flip cannot change its own score. Ties keep it where it is.
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
  // Off the top of the viewport is not a worse degree of the same thing: the
  // page may not scroll there at all, so it is disqualifying rather than
  // rankable. Keeping it out of the arithmetic is what stops a button 36px under
  // the tray being "improved" onto one 20px above the window.
  const hiddenExtent = (box: Box) => {
    if (box.top < viewportTop) return Infinity;

    const behindTray =
      tray && overlaps(box, tray)
        ? Math.min(box.bottom, tray.bottom) - Math.max(box.top, tray.top)
        : 0;
    const pastClip = clip
      ? Math.max(0, box.bottom - clip.bottom) + Math.max(0, clip.top - box.top)
      : 0;

    return Math.max(behindTray, pastClip);
  };

  const belowHidden = hiddenExtent(below);
  if (belowHidden === 0) return false;

  const aboveHidden = hiddenExtent(above);
  return aboveHidden === 0 || aboveHidden < belowHidden;
}
