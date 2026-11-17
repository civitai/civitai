import { IMAGES_CARD_FOOTER_ONE_ROW_HEIGHT } from '~/components/Image/Infinite/images-card-footer';

/** Tallest image area of a two-column-wide card; its footer is added on top. */
const SPAN_IMAGE_MAX_HEIGHT = 520;

/**
 * The cap on a two-column-wide card, or undefined when the feed does not span. A feed spans only
 * when its page opted in AND the flag is on AND it draws the standard card.
 */
export function getImagesSpanMaxHeight({
  optedIn,
  flagOn,
  customCard,
}: {
  optedIn?: boolean;
  flagOn?: boolean;
  customCard?: boolean;
}) {
  return optedIn && flagOn && !customCard
    ? SPAN_IMAGE_MAX_HEIGHT + IMAGES_CARD_FOOTER_ONE_ROW_HEIGHT
    : undefined;
}
