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
 *
 * The pointer is *captured* for the life of the gesture, which is what makes the
 * id sufficient. Three heuristics were tried before that and each answered a
 * different question than the one being asked, which is "is the pointer that
 * owns this gesture still down?": refusing whenever a gesture existed turned a
 * lost pointerup into a permanent lock, and `isPrimary` means "first active
 * pointer of its type", so a mouse is primary during a touch drag and a resting
 * thumb makes the dragging finger non-primary. Capture answers it directly —
 * the up or cancel is guaranteed to arrive, and `lostpointercapture` says so
 * explicitly when the browser takes it away.
 */
export type Gesture = { draftId: string; pointerId: number } & (
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

/**
 * The angle the knob is being dragged to, from the pointer's offset off the
 * sticker's centre, in the -180..180 the store stores.
 *
 * 🔴 THE WRAP IS THE WHOLE POINT. `atan2` returns -180..180 and the knob sits
 * straight up, so the `+ 90` that moves zero from right to up pushes the range
 * to -90..270 — and the store CLAMPS rotation to ±180 rather than wrapping it.
 * Every angle in the lower-left quadrant therefore came out above 180 and
 * clamped: dragging counterclockwise past 90° stopped dead and snapped the
 * sticker to 180°, a half-turn in the wrong direction from where the pointer
 * was. Wrapping maps that quadrant onto -180..-90, which is the same rotation
 * and is inside the clamp.
 */
export function knobRotation(dx: number, dy: number) {
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}
