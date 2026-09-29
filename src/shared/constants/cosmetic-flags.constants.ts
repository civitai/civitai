import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * Cosmetic Flags — bitwise moderator flags stored on `Cosmetic.flags`.
 *
 * Moderator-owned: the creator's edit path writes `Cosmetic.data`, never this.
 * Each flag is a power of 2. Check with `Flags.hasFlag(cosmetic.flags, CosmeticFlag.X)`.
 */
export const CosmeticFlag = {
  None: 0,

  /** A sticker that may not be placed on, or shown on, an R-or-higher image. */
  SfwPlacementsOnly: 1 << 0, // 1
} as const;

export type CosmeticFlagValue = (typeof CosmeticFlag)[keyof typeof CosmeticFlag];

export const cosmeticFlagLabels: Record<number, string> = {
  [CosmeticFlag.SfwPlacementsOnly]: 'SFW placements only',
};

export const STICKER_SFW_ONLY_REFUSAL =
  "This sticker can't be placed on mature images, or on images that haven't been rated yet.";

/**
 * Whether a sticker with these flags is kept off this image. The placement
 * guard, the approval guard, the tray and the placement listings all ask this
 * one question, so the threshold lives here and nowhere else.
 *
 * An unrated image (`nsfwLevel` 0, scan pending) counts as NSFW: a flagged
 * sticker waits for the rating rather than landing on an image that turns out
 * to be XXX.
 */
export function isStickerKeptOffImage({
  cosmeticFlags,
  imageNsfwLevel,
}: {
  cosmeticFlags: number;
  imageNsfwLevel: number;
}) {
  if (!Flags.hasFlag(cosmeticFlags, CosmeticFlag.SfwPlacementsOnly)) return false;
  return imageNsfwLevel === 0 || Flags.intersects(imageNsfwLevel, nsfwBrowsingLevelsFlag);
}
