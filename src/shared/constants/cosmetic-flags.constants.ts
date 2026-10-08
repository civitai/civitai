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
  /** A sticker that may not be placed on, or shown on, a PG or PG-13 image. */
  NsfwPlacementsOnly: 1 << 1, // 2
} as const;

export type CosmeticFlagValue = (typeof CosmeticFlag)[keyof typeof CosmeticFlag];

/**
 * Where a moderator lets a sticker be placed. One value rather than two
 * switches, so SFW-only and NSFW-only can never both be on.
 */
export const stickerPlacementRatings = ['any', 'sfwOnly', 'nsfwOnly'] as const;
export type StickerPlacementRating = (typeof stickerPlacementRatings)[number];

export const stickerPlacementRatingFlags: Record<StickerPlacementRating, number> = {
  any: CosmeticFlag.None,
  sfwOnly: CosmeticFlag.SfwPlacementsOnly,
  nsfwOnly: CosmeticFlag.NsfwPlacementsOnly,
};

export const STICKER_PLACEMENT_RATING_MASK =
  CosmeticFlag.SfwPlacementsOnly | CosmeticFlag.NsfwPlacementsOnly;

export function getStickerPlacementRating(cosmeticFlags: number): StickerPlacementRating {
  if (Flags.hasFlag(cosmeticFlags, CosmeticFlag.SfwPlacementsOnly)) return 'sfwOnly';
  if (Flags.hasFlag(cosmeticFlags, CosmeticFlag.NsfwPlacementsOnly)) return 'nsfwOnly';
  return 'any';
}

export const STICKER_SFW_ONLY_REFUSAL =
  "This sticker can't be placed on mature images, or on images that haven't been rated yet.";
export const STICKER_NSFW_ONLY_REFUSAL =
  "This sticker can only be placed on mature images, and not on images that haven't been rated yet.";

export const stickerPlacementRefusal = (cosmeticFlags: number) =>
  Flags.hasFlag(cosmeticFlags, CosmeticFlag.SfwPlacementsOnly)
    ? STICKER_SFW_ONLY_REFUSAL
    : STICKER_NSFW_ONLY_REFUSAL;

/**
 * Whether a sticker with these flags is kept off this image. The placement
 * guard, the approval guard, the tray, the tray's shop and the placement
 * listings all ask this one question.
 *
 * Unrated (0) is kept off in both directions: a flagged sticker waits for the
 * rating rather than landing on an image that turns out to be the other kind.
 * A row carrying both bits is kept off everything.
 */
export function isStickerKeptOffImage({
  cosmeticFlags,
  imageNsfwLevel,
}: {
  cosmeticFlags: number;
  imageNsfwLevel: number;
}) {
  if (!Flags.intersects(cosmeticFlags, STICKER_PLACEMENT_RATING_MASK)) return false;
  // A level that did not arrive as a number is a broken read, not a rating.
  if (!Number.isInteger(imageNsfwLevel) || imageNsfwLevel === 0) return true;

  const isSafe = getIsSafeBrowsingLevel(imageNsfwLevel);
  if (Flags.hasFlag(cosmeticFlags, CosmeticFlag.SfwPlacementsOnly) && !isSafe) return true;
  if (Flags.hasFlag(cosmeticFlags, CosmeticFlag.NsfwPlacementsOnly) && isSafe) return true;
  return false;
}
