import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
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

export const STICKER_SFW_ONLY_REFUSAL =
  "This sticker can't be placed on mature images, or on images that haven't been rated yet.";

/**
 * Whether a sticker with these flags is kept off this image. The placement
 * guard, the approval guard, the tray, the tray's shop and the placement
 * listings all ask this one question.
 *
 * The threshold is the site's own SFW line, unrated (0) included: a flagged
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
  // A level that did not arrive as a number is a broken read, not a safe image.
  return !Number.isInteger(imageNsfwLevel) || !getIsSafeBrowsingLevel(imageNsfwLevel);
}
