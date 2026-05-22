// Pure gesture-decision helpers for InteractiveTipBuzzButton.
//
// These are deliberately kept in a standalone file (no React / Mantine imports)
// so they can be unit-tested without loading the whole component graph — see
// InteractiveTipBuzzButton.test.ts.

// Pointer-movement tolerance (px) for the onMouseLeave abort decision. A real
// scroll/drag moves the pointer well beyond this; an incidental few-pixel drift
// off the edge of a small feed button while the user holds a quick tap stays
// within it. Only movement past this radius is treated as a genuine drag.
export const PRESS_MOVE_TOLERANCE = 10;

/**
 * Decides whether an `onMouseLeave` firing mid-press should abort the gesture.
 *
 * Pure so it can be unit-tested without rendering the component. Abort only
 * when BOTH are true:
 *  - the press has not committed yet (the 150ms hold timer is still pending),
 *    i.e. `pressUncommitted` — a committed hold is a deliberate tip and is
 *    completed even if the cursor then drifts off; and
 *  - the pointer genuinely moved past `PRESS_MOVE_TOLERANCE` from where the
 *    press started — a real scroll/drag. An incidental few-pixel drift off the
 *    small button edge is NOT a drag, so the quick tap is allowed to complete.
 *
 * When the press origin is unknown (`origin` null) we cannot measure drift, so
 * we conservatively treat the leave as a real drag and abort.
 */
export function shouldAbortPressOnLeave({
  pressUncommitted,
  origin,
  current,
  tolerance = PRESS_MOVE_TOLERANCE,
}: {
  pressUncommitted: boolean;
  origin: { x: number; y: number } | null;
  current: { x: number; y: number };
  tolerance?: number;
}): boolean {
  if (!pressUncommitted) return false;
  if (!origin) return true;
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  return dx * dx + dy * dy > tolerance * tolerance;
}
