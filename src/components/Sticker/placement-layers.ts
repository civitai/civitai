/**
 * The stacking order of the layers drawn over one image's media box.
 *
 * Shared because the two files that set these numbers are the two that must not
 * be read separately: `StickerPlacementOverlay` raised the owner's controls
 * above everything so a placement could always be answered, and that silently
 * put them above the sticker someone is currently dragging.
 */

/** The owner's approve/decline, above the placed stickers and the draft. */
export const PENDING_CONTROL_Z = 1000;

/**
 * The sticker being placed, above every pending control.
 *
 * Justin's call: whatever is under the cursor wins. The controls stay reachable
 * the moment the draft is put down or bought, and a draft only exists while
 * someone is actively arranging one.
 */
export const DRAFT_STICKER_Z = 2000;
