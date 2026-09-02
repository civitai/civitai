import { describe, expect, it } from 'vitest';
import type { Box } from '~/components/Sticker/place-button-position';
import {
  candidateDistance,
  chromeClearance,
  placeButtonBoxes,
  shouldFlipPlaceButton,
} from '~/components/Sticker/place-button-position';

/** The real page at 1400x900: tray band, and the carousel viewport that clips. */
const TRAY: Box = { top: 760, bottom: 900, left: 0, right: 1400 };
const CLIP: Box = { top: 60, bottom: 846, left: 213, right: 737 };

const box = (top: number, height = 36, left = 600, right = 732): Box => ({
  top,
  bottom: top + height,
  left,
  right,
});

const KNOB = 0.22;
const OUTSET = 6;
const GAP = 8;

const clearance = (over: Partial<Parameters<typeof chromeClearance>[0]> = {}) =>
  chromeClearance({
    width: 100,
    height: 200,
    rotation: 0,
    knobOffset: KNOB,
    outset: OUTSET,
    gap: GAP,
    ...over,
  });

/**
 * Where the furthest corner of the turned sticker actually lands on screen,
 * derived from the corners rather than from the formula under test.
 *
 * The local rectangle is the artwork's box grown by the handles on every side
 * and by the rotate knob on top, about the centre the sticker turns about. CSS
 * `rotate` sends `(x, y)` to `(x·cos − y·sin, x·sin + y·cos)`, so the screen
 * vertical of a corner is `x·sin + y·cos`.
 */
function rotatedReach({
  width,
  height,
  rotation,
}: {
  width: number;
  height: number;
  rotation: number;
}) {
  const radians = (rotation * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const xs = [-(width / 2 + OUTSET), width / 2 + OUTSET];
  const ys = [-(height / 2 + Math.max(KNOB * height, OUTSET)), height / 2 + OUTSET];
  const screenY = xs.flatMap((x) => ys.map((y) => x * sin + y * cos));

  return { down: Math.max(...screenY), up: Math.min(...screenY) };
}

/**
 * 🔴 THE TICKET. The chrome is laid out against the sticker's UNROTATED box and
 * has to clear its ROTATED one, because the rotation now lives on an inner
 * element and the chrome is that element's sibling. Every case here is a
 * position that was wrong before that split, and none of them may be satisfied
 * by a constant.
 */
describe('chromeClearance', () => {
  it('clears only the handles below and the rotate knob above at rest', () => {
    // The knob hangs 0.22 of a 200px sticker — 44px — above the top edge, and
    // the corner handles reach 6px past every edge.
    expect(clearance()).toEqual({ below: OUTSET + GAP, above: 44 + GAP });
  });

  it('moves the knob-sized standoff to the BELOW side at half a turn', () => {
    // The bug this fixes, stated as a number: at 180 degrees the knob is under
    // the sticker on screen, so the side needing the bigger standoff is the one
    // the toolbar sits on. Chrome that rides the rotation instead lands on the
    // artwork here.
    expect(clearance({ rotation: 180 })).toEqual({ below: 44 + GAP, above: OUTSET + GAP });
  });

  it('is driven by the WIDTH on its side, where height says nothing', () => {
    // A wide, short sticker turned upright reaches further vertically than its
    // own box ever does — the case a height-only clearance gets backwards.
    const wide = chromeClearance({
      width: 400,
      height: 60,
      rotation: 90,
      knobOffset: KNOB,
      outset: OUTSET,
      gap: GAP,
    });

    expect(wide.below).toBeCloseTo(400 / 2 + OUTSET - 60 / 2 + GAP);
    expect(wide.below).toBeGreaterThan(clearance({ rotation: 90 }).below);
  });

  it('scales with the sticker rather than sitting at a fixed distance', () => {
    // A constant passes the resting case above and fails here, which is the
    // whole point of asserting two sizes.
    expect(clearance({ height: 400 }).above).toBe(0.22 * 400 + GAP);
    expect(clearance({ height: 100 }).above).toBe(0.22 * 100 + GAP);
  });

  it('keeps the chrome exactly one gap clear of the turned sticker, at every angle', () => {
    // The property, checked against corners derived independently of the
    // formula: the cluster's near edge is the furthest the sticker reaches, plus
    // the gap, and never less.
    for (const rotation of [0, 12, 45, 90, 137, 180, -45, -90, -173]) {
      for (const [width, height] of [
        [100, 200],
        [400, 60],
        [51, 51],
      ]) {
        const { below, above } = chromeClearance({
          width,
          height,
          rotation,
          knobOffset: KNOB,
          outset: OUTSET,
          gap: GAP,
        });
        const reach = rotatedReach({ width, height, rotation });

        // Positions in the unrotated box's own frame, centre at 0.
        expect(height / 2 + below).toBeCloseTo(reach.down + GAP);
        expect(-(height / 2 + above)).toBeCloseTo(reach.up - GAP);
      }
    }
  });
});

describe('candidateDistance', () => {
  // The caption under the button carries a creator's username, so the cluster
  // has no reliable height. It is anchored by the edge nearest the sticker and
  // grows away from it, so its height moves the far edge only — which is the
  // distance between the two candidate positions, and nothing else.
  it('grows with the cluster, one pixel for one pixel', () => {
    const base = { height: 200, below: 14, above: 52 };
    expect(candidateDistance({ ...base, clusterHeight: 36 })).toBe(302);
    expect(candidateDistance({ ...base, clusterHeight: 52 })).toBe(318);
    expect(candidateDistance({ ...base, clusterHeight: 88 })).toBe(354);
  });

  it('tracks the sticker and each standoff independently', () => {
    const base = { height: 200, clusterHeight: 36, below: 14, above: 52 };
    expect(candidateDistance({ ...base, height: 300 })).toBe(402);
    expect(candidateDistance({ ...base, below: 30 })).toBe(318);
    expect(candidateDistance({ ...base, above: 74 })).toBe(324);
  });

  it('is the real gap between the two positions the CSS produces', () => {
    // Unflipped spans [H/2 + below, ... + cluster] from the box's centre;
    // flipped spans [-H/2 - above - cluster, -H/2 - above]. The distance is
    // between matching edges.
    const height = 94;
    const clusterHeight = 52;
    const { below, above } = clearance({ height, width: 94, rotation: 30 });

    const unflippedTop = height / 2 + below;
    const flippedTop = -height / 2 - above - clusterHeight;

    expect(candidateDistance({ height, clusterHeight, below, above })).toBeCloseTo(
      unflippedTop - flippedTop
    );
  });
});

describe('placeButtonBoxes', () => {
  it('puts the alternative straight below', () => {
    const current = box(300);
    const { below, above } = placeButtonBoxes({ current, flipped: true, distance: 252 });

    expect(above).toEqual(current);
    expect(below.top).toBeCloseTo(552);
    expect(below.bottom).toBeCloseTo(588);
  });

  /**
   * 🔴 VERTICAL WHATEVER THE STICKER IS DOING, and that is a claim about the DOM
   * rather than about this function. The cluster used to be a child of the
   * rotated element, so its "below" swung around the sticker and this had to
   * take an angle to undo it. It is now a sibling of the rotated element, so
   * screen-down is the only direction there is — a version of this that took an
   * angle again would mean the chrome had been put back inside the rotation.
   */
  it('does not move sideways, because nothing above the cluster rotates', () => {
    const current = box(300);
    const { below } = placeButtonBoxes({ current, flipped: true, distance: 100 });

    expect(below.left).toBe(current.left);
    expect(below.right).toBe(current.right);
    expect(below.top).toBeCloseTo(400);
  });

  it('gives the same pair whichever position the cluster is in', () => {
    // The property the whole design rests on: no feedback, so flipping cannot
    // remove its own cause.
    const fromBelow = placeButtonBoxes({ current: box(300), flipped: false, distance: 252 });
    const fromAbove = placeButtonBoxes({
      current: fromBelow.above,
      flipped: true,
      distance: 252,
    });

    expect(fromAbove.below.top).toBeCloseTo(fromBelow.below.top);
    expect(fromAbove.above.top).toBeCloseTo(fromBelow.above.top);
  });
});

describe('shouldFlipPlaceButton', () => {
  const decide = (below: Box, above: Box, tray: Box | null = TRAY, clip: Box | null = CLIP) =>
    shouldFlipPlaceButton({ below, above, tray, clip });

  it('leaves a button that is already visible alone', () => {
    expect(decide(box(400), box(200))).toBe(false);
  });

  it('flips a button the tray would cover', () => {
    expect(decide(box(730), box(400))).toBe(true);
  });

  it('decides on the whole wrapper, not on a one-line button', () => {
    // A single-line button clears the tray at this position; the two-line one
    // that lands with the merged copy does not.
    expect(decide(box(715, 36), box(400, 36))).toBe(false);
    expect(decide(box(715, 52), box(400, 52))).toBe(true);
  });

  it('flips a button the carousel would clip', () => {
    // Below the media box but above the tray band: invisible for the other
    // reason, and a tray-only test would leave it broken.
    const tallClip: Box = { top: 60, bottom: 500, left: 213, right: 737 };
    expect(decide(box(480), box(200), TRAY, tallClip)).toBe(true);
  });

  it('does not flip when the flipped position is also hidden', () => {
    // A sticker tall enough that both ends are in trouble. Flipping here moves
    // the button without fixing anything.
    expect(decide(box(800), box(730))).toBe(false);
  });

  it('does not flip a button off the top of the viewport', () => {
    expect(decide(box(800), box(-20))).toBe(false);
    expect(decide(box(800), box(70))).toBe(true);
  });

  it('does not flip off the top of the viewport with no clip to catch it', () => {
    // The case above is satisfied by the clip check alone, because the carousel
    // starts at y=60. With no clipping ancestor — or one starting at the top of
    // the viewport — the viewport guard is the only thing left.
    expect(decide(box(800), box(-20), TRAY, null)).toBe(false);
    expect(decide(box(800), box(10), TRAY, null)).toBe(true);

    const fullHeightClip: Box = { top: 0, bottom: 900, left: 0, right: 1400 };
    expect(decide(box(800), box(-20), TRAY, fullHeightClip)).toBe(false);
  });

  it('flips away from the top edge of the clip, not just the bottom', () => {
    // Above the carousel viewport but still on screen: clipped at the top, which
    // nothing else would catch.
    expect(decide(box(800), box(20))).toBe(false);
    expect(decide(box(800), box(65))).toBe(true);
  });

  it('treats a button resting exactly on the tray edge as visible', () => {
    // Touching is not overlapping. Flipping here would move a button nobody is
    // having trouble seeing.
    expect(decide(box(724), box(400))).toBe(false);
    expect(decide(box(725), box(400))).toBe(true);
  });

  it('does not flip when the sticker is beside the tray rather than above it', () => {
    const narrowTray: Box = { top: 760, bottom: 900, left: 500, right: 900 };
    const wideClip: Box = { top: 0, bottom: 900, left: 0, right: 1400 };
    expect(decide(box(780, 36, 100, 232), box(300, 36, 100, 232), narrowTray, wideClip)).toBe(
      false
    );
    expect(decide(box(780, 36, 600, 732), box(300, 36, 600, 732), narrowTray, wideClip)).toBe(true);
  });

  it('has nothing to say with neither a tray nor a clip', () => {
    expect(decide(box(800), box(300), null, null)).toBe(false);
  });
});

/**
 * 🔴 THE DERIVED BOX IS A WHOLE BOX, INCLUDING THE EDGES NOTHING MOVES.
 *
 * `placeButtonBoxes` is handed a real `DOMRect`, whose properties are getters on
 * the PROTOTYPE rather than own enumerable ones. `{ ...rect }` therefore copies
 * nothing, and a derived box built that way has `left`/`right` undefined —
 * `overlaps` evaluates `undefined > tray.left` as `false`, so the tray goes
 * invisible to whichever box was derived.
 *
 * Measured on the image detail page at the flip boundary: unflipped, `below` was
 * the real rect, saw the tray and flipped; flipped, `below` was derived, could
 * not see the tray and unflipped. 39 alternations and "Maximum update depth
 * exceeded". The numbers below are that capture.
 *
 * ⚠️ THE FIXTURE MUST NOT BE AN OBJECT LITERAL. Spreading a literal works, so a
 * literal passes with or without the bug and pins nothing. `rectLike` puts the
 * edges on a prototype, the way the browser does.
 */
describe('the candidate boxes survive coming from a DOMRect', () => {
  const rectLike = (top: number, bottom: number, left: number, right: number): Box =>
    Object.create(
      Object.defineProperties(
        {},
        {
          top: { get: () => top },
          bottom: { get: () => bottom },
          left: { get: () => left },
          right: { get: () => right },
        }
      )
    ) as Box;

  const MEASURED_TRAY: Box = { top: 1087, bottom: 1355, left: 0, right: 1270 };
  const MEASURED_CLIP: Box = { top: 92, bottom: 1301, left: 0, right: 820 };
  const DISTANCE = 319;

  it('spreads to nothing, which is why the fixture is not a literal', () => {
    // The negative control for the two cases below: if this ever starts copying
    // edges, they pass for a reason that has nothing to do with the fix.
    expect({ ...rectLike(1, 2, 3, 4) }).toEqual({});
  });

  it('keeps left and right on the box it derives', () => {
    const { above } = placeButtonBoxes({
      current: rectLike(969, 1096, 322, 454),
      flipped: false,
      distance: DISTANCE,
    });

    expect(above.left).toBe(322);
    expect(above.right).toBe(454);
  });

  it('decides the same thing whichever side the cluster is currently on', () => {
    const decide = (current: Box, flipped: boolean) =>
      shouldFlipPlaceButton({
        ...placeButtonBoxes({ current, flipped, distance: DISTANCE }),
        tray: MEASURED_TRAY,
        clip: MEASURED_CLIP,
      });

    // Same sticker, same frame, one measurement from each side. The second was
    // `false` while the derived box could not see the tray, and the pair of
    // answers is what the loop was made of.
    expect(decide(rectLike(969, 1096, 322, 454), false)).toBe(true);
    expect(decide(rectLike(651, 778, 322, 454), true)).toBe(true);
  });
});
