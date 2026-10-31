/** The parts of a `DOMRect` this needs, so the geometry is testable without a DOM. */
export type Box = { top: number; bottom: number; left: number; right: number };

const overlaps = (a: Box, b: Box) =>
  a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;

/**
 * 🔴 EVERY FIELD BY NAME. NEVER `{ ...box }`.
 *
 * `current` is a real `DOMRect`, whose properties are getters on the prototype
 * rather than own enumerable ones — so a spread copies NOTHING and the derived
 * box comes out with `left` and `right` undefined. `overlaps` then evaluates
 * `undefined > tray.left`, which is `false`, so the tray becomes invisible to
 * whichever of the two boxes was derived. Each side then argues for the other —
 * the real rect sees the tray and flips, the derived one cannot and unflips —
 * until React gives up with "Maximum update depth exceeded".
 *
 * The `Box` type cannot catch this — `DOMRect` satisfies it structurally, and
 * the spread of one type-checks as `Box` while being empty at runtime.
 */
const shiftDown = (box: Box, dy: number): Box => ({
  top: box.top + dy,
  bottom: box.bottom + dy,
  left: box.left,
  right: box.right,
});

/**
 * How far the draft's chrome has to stand off the sticker's own box to clear the
 * sticker at the angle it is currently turned to.
 *
 * The chrome is drawn OUTSIDE the rotated element — see `DraftSticker` — so it
 * is laid out against the sticker's unrotated box while the thing it has to
 * avoid is the rotated one. The two differ by the whole reason this ticket
 * exists: a clearance derived from the local edge is right at 0° and wrong
 * everywhere else, and a constant is wrong at every size.
 *
 * 🔴 DERIVED, NEVER A CONSTANT. Nothing here may become a fixed number of
 * pixels. The caption under the button carries a creator's username, so the
 * cluster's own height has no bound worth relying on — but it is anchored by
 * the edge nearest the sticker and grows away from it, so its height cannot
 * enter this. What does enter it is the sticker's measured size and angle.
 *
 * Returns the two standoffs in px, `below` measured from the box's bottom edge
 * downwards and `above` from its top edge upwards. Either can come out negative
 * — a tall narrow sticker turned onto its side reaches less far vertically than
 * its own box does — which is correct: the chrome then sits closer than the
 * unrotated edge, still clear of the artwork.
 */
export function chromeClearance({
  width,
  height,
  rotation,
  knobOffset,
  outset,
  gap,
}: {
  /** The sticker's unrotated layout width in px — `offsetWidth`. */
  width: number;
  /** The sticker's unrotated layout height in px — `offsetHeight`. */
  height: number;
  /** Degrees, ±180. */
  rotation: number;
  /** The rotate knob hangs this fraction of the sticker's height above it. */
  knobOffset: number;
  /** How far the corner handles stick out past the box on every side. */
  outset: number;
  /** Clear air between the furthest thing on the sticker and the chrome. */
  gap: number;
}): { below: number; above: number } {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.abs(Math.sin(radians));

  // The local rectangle to clear, about the sticker's centre. Asymmetric,
  // because the rotate knob only hangs off the top — and it is what makes this
  // more than the usual `h·|cos| + w·|sin|` extent: that formula is for a
  // rectangle centred on the point it turns about, and the knob is not.
  const top = -(height / 2 + Math.max(knobOffset * height, outset));
  const bottom = height / 2 + outset;
  // Every corner shares the same |x·sin| reach, so only the y term differs.
  const side = (width / 2 + outset) * sin;

  const reachDown = side + Math.max(top * cos, bottom * cos);
  const reachUp = side - Math.min(top * cos, bottom * cos);

  return {
    below: reachDown - height / 2 + gap,
    above: reachUp - height / 2 + gap,
  };
}

/**
 * How far apart the two positions are, in screen pixels.
 *
 * Reads the cluster's height rather than assuming one: it holds the toolbar,
 * the note field and the payout caption as well as the button, so a longer
 * username or an opened note makes it taller. Whichever side it is on it is
 * anchored by its edge nearest the sticker and grows away, so its height moves
 * the FAR edge only — which is why it belongs here, in the distance between the
 * two candidate positions, and not in `chromeClearance`.
 */
export const candidateDistance = ({
  height,
  clusterHeight,
  below,
  above,
}: {
  /** The sticker's unrotated layout height in px. */
  height: number;
  clusterHeight: number;
  /** The two standoffs from `chromeClearance`. */
  below: number;
  above: number;
}) => height + below + above + clusterHeight;

/**
 * The two places the cluster can be, both as screen boxes.
 *
 * Purely vertical, which it was not before: the cluster used to be a child of
 * the rotated element, so "below" was only below on screen at rotation 0 and
 * the pair had to be derived by rotating the local offset into screen space.
 * Now that nothing above it rotates, the alternative really is straight up or
 * straight down.
 *
 * Deriving the pair rather than reading each position is what keeps the decision
 * free of feedback: the same two boxes come out whichever position the cluster
 * is currently in, so flipping can never remove the condition that caused it and
 * start oscillating.
 */
export function placeButtonBoxes({
  current,
  flipped,
  distance,
}: {
  current: Box;
  flipped: boolean;
  distance: number;
}): { below: Box; above: Box } {
  return flipped
    ? { above: current, below: shiftDown(current, distance) }
    : { below: current, above: shiftDown(current, -distance) };
}

/** More than the candidate model can be off by, so a flip never undoes itself. */
const FLIP_MARGIN = 2;

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
  flipped = false,
  viewportTop = 0,
}: {
  below: Box;
  above: Box;
  tray: Box | null;
  clip: Box | null;
  /** Which side the cluster is on now: the other side is the one held to the margin. */
  flipped?: boolean;
  viewportTop?: number;
}) {
  const hidden = (box: Box, margin = 0) => {
    // By name, never a spread: `box` can be a DOMRect (see `shiftDown`).
    const grown: Box = {
      top: box.top - margin,
      bottom: box.bottom + margin,
      left: box.left,
      right: box.right,
    };
    return (
      grown.top < viewportTop ||
      (!!tray && overlaps(grown, tray)) ||
      (!!clip && (grown.bottom > clip.bottom || grown.top < clip.top))
    );
  };

  // 🔴 THE SIDE IT WOULD MOVE TO HAS TO CLEAR BY A MARGIN. One of the two
  // candidates is measured and the other is modelled, so they can disagree by a
  // fraction of a pixel; without slack a cluster edge in that sliver flips,
  // finds the model was wrong, flips back, and never settles (React #185).
  return flipped
    ? hidden(below, FLIP_MARGIN) && !hidden(above)
    : hidden(below) && !hidden(above, FLIP_MARGIN);
}

/**
 * What `placeButtonPosition` may read from an element: its rect, never `offset*`.
 * Rects are screen px while the standoffs are written back as CSS px, which
 * agree only while nothing above the overlay is scaled.
 */
type Measurable = { getBoundingClientRect(): Box & { width: number; height: number } };

/**
 * Which side of the sticker the buy cluster belongs on, and the standoffs for
 * it, from the live elements — or `null` while the sticker has no size yet.
 *
 * Whole here rather than in `DraftSticker` so the two facts the flip depends on
 * are testable: every height is a rect height, and the current side is passed
 * through to `shouldFlipPlaceButton`.
 */
export function placeButtonPosition({
  sticker,
  cluster,
  tray,
  clip,
  flipped,
  rotation,
  knobOffset,
  outset,
  gap,
}: {
  sticker: Measurable;
  cluster: Measurable;
  tray: Box | null;
  clip: Box | null;
  flipped: boolean;
  rotation: number;
  knobOffset: number;
  outset: number;
  gap: number;
}): { flipped: boolean; below: number; above: number } | null {
  // The artwork rotates inside the sticker's element, so the element's box is
  // the unrotated one the chrome is laid out against.

  // 🔴 FRACTIONAL, LIKE THE RECT THE CANDIDATES START FROM. `offsetHeight`
  // rounds, and when this and the cluster's height both round down the
  // modelled jump comes out shorter than the real one: a cluster edge inside
  // that sliver of the tray flips, then sees the tray miss it and unflips —
  // "Maximum update depth exceeded" (React #185).
  const { height, width } = sticker.getBoundingClientRect();
  // 🔴 AN UNMEASURED STICKER DECIDES NOTHING. `EdgeImage` has no intrinsic size
  // until it loads, so a draft dragged in from the tray measures 0 tall for its
  // first frames, and a flip decided from that puts the two candidates close
  // enough together that each argues for the other. Same rule as
  // `placementControlPosition`.
  if (!(height > 0) || !(width > 0)) return null;

  const clearance = chromeClearance({ width, height, rotation, knobOffset, outset, gap });
  // From the cluster's own measured rect, both times: the pair that comes out
  // is the same whichever side it is currently on.
  const current = cluster.getBoundingClientRect();
  const boxes = placeButtonBoxes({
    current,
    flipped,
    distance: candidateDistance({
      height,
      clusterHeight: current.height,
      below: clearance.below,
      above: clearance.above,
    }),
  });

  return {
    flipped: shouldFlipPlaceButton({ ...boxes, tray, clip, flipped }),
    below: clearance.below,
    above: clearance.above,
  };
}
