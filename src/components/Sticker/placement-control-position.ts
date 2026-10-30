export type ControlSize = { width: number; height: number };
export type ControlBox = { width: number; height: number };

/**
 * Where the owner's approve/decline controls go, in pixels, for a sticker
 * anchored anywhere on the image.
 *
 * 🔴 THE CLAMP IS THE WHOLE POINT. The controls used to be positioned purely
 * from the sticker — `left: x%`, `top: y% + halfStickerHeight + gap` — inside a
 * layer with `overflow-hidden`. Measured on a real placement at each edge: a
 * sticker at `y = 0.95` put both buttons **59px below** the box, entirely
 * clipped, and stickers at `x = 0.03` / `x = 0.97` put one button **42px past**
 * the side. Three edges out of four, and the owner's only in-image way to answer
 * a placement with them. The container was truncating what the anchor had
 * already pushed outside; nothing was reconciling the two.
 *
 * Below the sticker stays the preferred position — that is where the control has
 * always been and it is out of the artwork's way. It flips ABOVE only when below
 * does not fit, because a control laid over the sticker is a control over the
 * thing being judged.
 *
 * Pixels rather than percentages, matching the existing `top` calculation and
 * for the same reason: a percentage in `top` resolves against the box's height
 * while a sticker is sized from its width, and every attempt to reconcile those
 * by arithmetic has been wrong on some aspect ratio.
 *
 * Returns `null` when anything needed has not been measured yet. The caller then
 * keeps its unclamped position, which is the behaviour that shipped — a control
 * that jumps once on measurement is better than one that is briefly at 0,0.
 */
export function placementControlPosition({
  x,
  y,
  stickerHeight,
  gap,
  control,
  box,
}: {
  /** 0–1, fraction of the box's width. The sticker's centre. */
  x: number;
  /** 0–1, fraction of the box's height. */
  y: number;
  /** The sticker's measured visual height in px, rotation included. */
  stickerHeight: number;
  /** Clear air between the sticker and the controls. */
  gap: number;
  control: ControlSize;
  box: ControlBox;
}): { left: number; top: number } | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  if (!(control.width > 0) || !(control.height > 0)) return null;

  const centreY = y * box.height;
  const halfSticker = stickerHeight / 2;

  const below = centreY + halfSticker + gap;
  const above = centreY - halfSticker - gap - control.height;

  /**
   * Fits below, fits above, or neither.
   *
   * The third case is real rather than defensive: a sticker scaled large on a
   * short box can leave no room on either side, and clamping is then the only
   * honest answer — the controls end up overlapping the artwork, which is worse
   * than the alternative of being unreachable.
   */
  const top = below + control.height <= box.height ? below : above >= 0 ? above : below;

  return {
    // The caller drops its `-translate-x-1/2`: this is the control's LEFT edge,
    // so the clamp can be stated against the box rather than against a
    // half-width the transform hides.
    left: clamp(x * box.width - control.width / 2, 0, box.width - control.width),
    top: clamp(top, 0, box.height - control.height),
  };
}

/**
 * `max` before `min`, so a control taller or wider than the box lands at the
 * top-left rather than at a negative coordinate. Only reachable on a box smaller
 * than the buttons, which is a thumbnail rather than a review surface.
 */
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
