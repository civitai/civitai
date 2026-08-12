/**
 * Everything a gesture has to remember from the moment it started.
 *
 * Captured on pointer-down rather than recomputed per move, because both are
 * relative to where the grab happened: a move keeps the sticker under the point
 * you actually grabbed, and a resize holds the opposite corner still. Recomputing
 * either from the current state feeds the result back into its own input, which
 * is what makes a sticker jump to the cursor or crawl away from its anchor.
 *
 * `draftId` rather than "whichever is selected": a press both selects and starts
 * a drag, and there can be several drafts on the image, so resolving the target
 * at every pointer move would let a selection change redirect a gesture already
 * in flight.
 */
export type Gesture = { draftId: string } & (
  | { mode: 'move'; offsetX: number; offsetY: number }
  | { mode: 'rotate' }
  | { mode: 'resize'; anchorX: number; anchorY: number; sx: number; sy: number; aspect: number }
);

export const rotate = (x: number, y: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
};

/** Where the rotate knob sits above the sticker, as a fraction of its height. */
export const KNOB_OFFSET = 0.22;
