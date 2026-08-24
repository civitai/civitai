/**
 * The stacking order of the layers drawn over one image's media box.
 *
 * Shared because the two files that set these numbers only make sense read
 * together. Both are page-context numbers on paper: what actually keeps them
 * off the app's own ladder (`shared/constants/app-layout.constants.ts`) is the
 * centring transform on `ImageStickerOverlay`'s surface div, which makes that
 * div a stacking context. Restyle it to flex centring and these escape.
 */

/** The owner's approve/decline, above every placed sticker; below the draft. */
export const PENDING_CONTROL_Z = 1000;

/**
 * The sticker being placed, above every pending control.
 *
 * Justin's call: whatever is under the cursor wins. The controls stay reachable
 * the moment the draft is put down or bought, and a draft only exists while
 * someone is actively arranging one.
 */
export const DRAFT_STICKER_Z = 2000;
