import { COMMON_IMAGE_WIDTHS } from '~/client-utils/edge-url';

const MOBILE_MAX_IMAGE_HEIGHT = '60vh';
// Desktop slides share one height and take their width from the image, so as many as fit show.
export const DESKTOP_IMAGE_HEIGHT = '55vh';
const DEFAULT_IMAGE_WIDTH = 800;
const WIDE_IMAGE_MAX_WIDTH = 1600;

/**
 * A landscape desktop slide is wider than the default request: its slot is the image's ratio
 * times the slide height, which can pass 1500px. Ask for the largest ladder width the source
 * can fill (the edge rounds any other width UP and enlarges past the source), capped at
 * 1600. Phones and portrait or square images keep the default.
 */
export function getReviewImageWidth(
  { width, height }: { width?: number | null; height?: number | null },
  mobile = false
) {
  if (mobile || !width || !height || width <= height) return DEFAULT_IMAGE_WIDTH;
  const limit = Math.min(width, WIDE_IMAGE_MAX_WIDTH);
  const fits = COMMON_IMAGE_WIDTHS.filter((w) => w <= limit && w >= DEFAULT_IMAGE_WIDTH);
  return fits.length ? Math.max(...fits) : DEFAULT_IMAGE_WIDTH;
}

/** The slide's box: the image's own shape, so a placeholder or `MediaHash` has a size to fill. */
export function getReviewSlideSize(
  { width, height }: { width?: number | null; height?: number | null },
  mobile: boolean
) {
  const ratio = width && height ? width / height : 1;
  return mobile
    ? { aspectRatio: ratio, width: `min(100%, calc(${MOBILE_MAX_IMAGE_HEIGHT} * ${ratio}))` }
    : { aspectRatio: ratio, height: DESKTOP_IMAGE_HEIGHT, maxWidth: '100%' };
}
