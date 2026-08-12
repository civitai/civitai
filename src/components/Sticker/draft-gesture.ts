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
 *
 * `pointerId` because the drafts share one gesture and one pair of window
 * listeners. `touchAction: 'none'` means the browser hands us every touch stream
 * rather than treating the second finger as a scroll, so without this a second
 * finger anywhere would overwrite the gesture — the first finger would start
 * dragging the second finger's sticker — and lifting the second finger would
 * end the first finger's drag while it was still down.
 */
export type Gesture = { draftId: string; pointerId: number; isPrimary: boolean } & (
  | { mode: 'move'; offsetX: number; offsetY: number }
  | { mode: 'rotate' }
  | { mode: 'resize'; anchorX: number; anchorY: number; sx: number; sy: number; aspect: number }
);

/** Returns whether the gesture was taken; a refusal means one is already live. */
export type StartGesture = (gesture: Gesture) => boolean;

export const rotate = (x: number, y: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
};

/** Where the rotate knob sits above the sticker, as a fraction of its height. */
export const KNOB_OFFSET = 0.22;
