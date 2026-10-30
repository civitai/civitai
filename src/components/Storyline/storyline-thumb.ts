export type StorylineThumbRatio = '3/4' | '4/5' | '16/6';

const RATIOS: Record<StorylineThumbRatio, number> = { '3/4': 3 / 4, '4/5': 4 / 5, '16/6': 16 / 6 };

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
  return Math.round(width * 2 * Math.max(1, imageRatio / RATIOS[ratio]));
}
