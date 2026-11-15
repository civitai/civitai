import { COMMON_IMAGE_WIDTHS } from '~/client-utils/edge-url';

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
