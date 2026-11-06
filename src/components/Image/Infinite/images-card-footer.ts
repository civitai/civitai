/** One row: reactions, tip and badges side by side. */
export const IMAGES_CARD_FOOTER_ONE_ROW_HEIGHT = 38;
/** Two rows: reactions on top, tip and badges below. */
export const IMAGES_CARD_FOOTER_TWO_ROW_HEIGHT = 59;
/**
 * A card at least this wide fits every reaction, the tip and the badges on one row. Below it the
 * footer takes two rows. The worst case (four 3-digit counts, a 3-digit tip, the sticker chip and the
 * hat button) fit one row from 352px in local measurement; 400 leaves a margin for narrower fonts.
 */
export const IMAGES_CARD_ONE_ROW_MIN_WIDTH = 400;

/** Whether a card of this width lays its footer out on one row. An unknown width is wide. */
export function isImagesCardFooterOneRow(width?: number) {
  return width === undefined || width >= IMAGES_CARD_ONE_ROW_MIN_WIDTH;
}

/**
 * The footer height a card of this width takes. The masonry reserves exactly this and the card
 * draws exactly this, so both read it from here: when they disagree the picture loses its bottom.
 */
export function getImagesCardFooterHeight(width?: number) {
  return isImagesCardFooterOneRow(width)
    ? IMAGES_CARD_FOOTER_ONE_ROW_HEIGHT
    : IMAGES_CARD_FOOTER_TWO_ROW_HEIGHT;
}

/** What the masonry reserves for a card: the picture, clamped, plus the footer for this width. */
export function getImagesCardHeight(pictureHeight: number, width?: number) {
  return Math.max(Math.min(pictureHeight, 600), 150) + getImagesCardFooterHeight(width);
}

/**
 * The masonry's height callback for ImagesCard feeds. A custom card draws no such footer, so it
 * keeps the one-row gap it always had.
 */
export function adjustImagesCardHeight(
  { height, width }: { height: number; width: number },
  customCard?: boolean
) {
  return getImagesCardHeight(height, customCard ? undefined : width);
}
