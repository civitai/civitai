/** The parts of a `DOMRect` this needs, so the decision is testable without a DOM. */
export type Box = { top: number; bottom: number; left: number; right: number };

const overlaps = (a: Box, b: Box) =>
  a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;

/**
 * Whether the buy button belongs above the sticker rather than below it.
 *
 * The tray is `fixed` at `z-30`; the sticker overlay is a `transform`ed element
 * with `z-index: auto`, so the tray paints over everything in it no matter what
 * the button's own z-index is. A sticker positioned low therefore puts its
 * button underneath the tray, where it cannot be seen or pressed. Lifting the
 * overlay above the tray instead would hide the tray, which is the same bug
 * pointing the other way, so the button moves rather than the layers.
 *
 * Measured against where the button would sit UNFLIPPED, never against where it
 * currently sits: testing the live position makes flipping remove the condition
 * that caused it, and the button oscillates for as long as it is dragged.
 */
export function shouldFlipPlaceButton({
  sticker,
  tray,
  buttonHeight,
  gap,
}: {
  sticker: Box;
  tray: Box | null;
  buttonHeight: number;
  gap: number;
}) {
  if (!tray || buttonHeight <= 0) return false;

  const below: Box = {
    top: sticker.bottom + gap,
    bottom: sticker.bottom + gap + buttonHeight,
    left: sticker.left,
    right: sticker.right,
  };

  if (!overlaps(below, tray)) return false;

  // Flipping has to leave the button somewhere better. On a sticker near the top
  // of a short viewport it would land off-screen, which is worse than the tray
  // covering it -- at least that one scrolls back into view when the tray closes.
  return sticker.top - gap - buttonHeight >= 0;
}
