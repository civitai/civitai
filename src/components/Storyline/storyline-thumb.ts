export type StorylineThumbRatio = '3/4' | '4/5' | '16/6';

const RATIOS: Record<StorylineThumbRatio, number> = { '3/4': 3 / 4, '4/5': 4 / 5, '16/6': 16 / 6 };
/** Past this a wide image's extra width costs bytes without looking sharper in a feed tile. */
const WIDE_REQUEST_MAX = 1200;

/**
 * The width to request for a thumb `width` px wide, at 2x. An image wider than the box is cropped
 * to fill its height, so it is drawn wider than the box: requesting only the box width upscales it.
 */
export function storylineThumbRequestWidth(
  width: number,
  ratio: StorylineThumbRatio,
  image: { width?: number | null; height?: number | null }
) {
  const imageRatio = image.width && image.height ? image.width / image.height : 0;
  const base = width * 2;
  const drawn = Math.round(base * Math.max(1, imageRatio / RATIOS[ratio]));
  return Math.max(base, Math.min(drawn, WIDE_REQUEST_MAX));
}
