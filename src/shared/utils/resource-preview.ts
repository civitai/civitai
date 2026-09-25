import {
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

export function isPreviewVisible(nsfwLevel: number | null | undefined, browsingLevel: number) {
  return Flags.intersects(nsfwLevel ?? 0, onlySelectableLevels(browsingLevel));
}

/** An absent level is an unestablished viewer, and resolves to the narrowest level (PG). */
export function pickPreviewImage<T extends { nsfwLevel: number }>(
  images: T[],
  browsingLevel: number | undefined
) {
  const level = browsingLevel ?? publicBrowsingLevelsFlag;
  return images.find((image) => isPreviewVisible(image.nsfwLevel, level));
}
