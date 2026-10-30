import type { ControlBox } from '~/components/Sticker/placement-control-position';

export type MarkSide = 'top' | 'bottom';

/**
 * Where a pending sticker's marks go, and whether there is room to draw them.
 *
 * "Free placement" wants the sticker's top edge and "Pending" the bottom, both
 * inside its box. Two things can spoil that, and this answers both.
 *
 * **The edge can be off-image.** Being cropped with the artwork is fine and
 * deliberate — the sticker is half off-image too. Being cropped *entirely* is
 * not: the mark is then absent, with nothing to say it was ever there. So a
 * mark moves to the opposite edge when its own edge is fully outside and the
 * other one is not. When both are gone neither moves, because the far side is
 * no better.
 *
 * **The sticker can be too small to hold them.** At `STICKER_PLACEMENT_MIN_SCALE`
 * a sticker is tens of pixels tall, and two marks anchored to opposite edges of
 * that overlap each other in the middle. `null` then, and the dashed ring and
 * the hover card carry it — a mark on top of another mark states nothing.
 *
 * 🔴 ROTATION IS WHY THIS TAKES `rotation` AND AN UNROTATED HEIGHT. The marks
 * live inside the sticker's own rotated box, so `'top'` is its LOCAL top — at
 * 180° that renders at the bottom of the screen. A flip decided in screen space
 * and applied in that frame is inverted for anything past ±90°: it would take a
 * mark that was fully visible and move it to the edge that is off-image. So the
 * local offsets are projected through `cos` before the test, which also makes
 * ±90° a no-op, correctly — the local top edge is a screen SIDE there, and
 * neither vertical edge is the one being cropped.
 *
 * Pixels against the media box, for the reason `placement-control-position.ts`
 * spells out: `y` resolves against the box's height while a sticker is sized
 * from its width, so the two cannot be reconciled on the fractions.
 */
export function placementMarkLayout({
  y,
  stickerHeight,
  rotation,
  markHeight,
  inset,
  gap,
  box,
  hasFree,
  hasPending,
}: {
  /** 0–1, the sticker's centre as a fraction of the box's height. */
  y: number;
  /**
   * The sticker's UNROTATED layout height in px — `offsetHeight`, not the
   * rotation-expanded extent `placementControlPosition` wants. The marks sit on
   * the box's own edges, so the local box is what they measure against.
   */
  stickerHeight: number;
  /** Degrees, ±180. */
  rotation: number;
  markHeight: number;
  /** Distance from the sticker's edge to the mark, matching the CSS inset. */
  inset: number;
  /** Space between two marks stacked on the same edge. */
  gap: number;
  box: ControlBox;
  hasFree: boolean;
  hasPending: boolean;
}): { free: MarkSide | null; pending: MarkSide | null } {
  const absent = { free: null, pending: null };
  const marks = (hasFree ? 1 : 0) + (hasPending ? 1 : 0);
  // Unmeasured draws nothing rather than drawing in the wrong place: a mark that
  // appears at the sticker's centre and then jumps is worse than one arriving a
  // frame late. The room test below covers an unmeasured sticker too — zero is
  // never tall enough — so only the box needs its own guard.
  if (!(box.height > 0) || !(markHeight > 0) || !marks) return absent;
  if (stickerHeight < marks * markHeight + 2 * inset + (marks - 1) * gap) return absent;

  const cos = Math.cos((rotation * Math.PI) / 180);
  const centre = y * box.height;
  // Distance from the sticker's centre to a mark's own centre, in the sticker's
  // frame, then projected onto the screen's vertical.
  const reach = (stickerHeight / 2 - inset - markHeight / 2) * cos;
  const half = markHeight / 2;
  const gone = (screenY: number) => screenY + half <= 0 || screenY - half >= box.height;

  const topGone = gone(centre - reach);
  const bottomGone = gone(centre + reach);

  return {
    free: hasFree ? (topGone && !bottomGone ? 'bottom' : 'top') : null,
    pending: hasPending ? (bottomGone && !topGone ? 'top' : 'bottom') : null,
  };
}
