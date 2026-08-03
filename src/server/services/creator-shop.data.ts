import type { CosmeticOffsets } from '~/server/schema/creator-shop.schema';
import { CosmeticType, MediaType } from '~/shared/utils/prisma/enums';
import {
  CREATOR_GRANT_USES_MULTIPLIER,
  stickerUsesFromCosmeticData,
} from '~/shared/utils/sticker-token';

// The cosmetic `data` blob is built server-side (never trust client-shaped data).
// Kept out of creator-shop.service so it can be tested without pulling sharp,
// prisma and the buzz/image services into the test's import graph.
export const buildCosmeticData = (
  type: CosmeticType,
  imageUrl: string,
  animated?: boolean,
  offsets?: CosmeticOffsets | null,
  slug?: string,
  uses?: number
) => {
  if (type === CosmeticType.Sticker)
    return { url: imageUrl, slug, animated: !!animated, ...(uses ? { uses } : {}) };
  if (type === CosmeticType.ProfileBackground)
    return { url: imageUrl, type: MediaType.image, animated: !!animated };
  if (type === CosmeticType.ProfileDecoration)
    return { url: imageUrl, animated: !!animated, ...(offsets ? { offsets } : {}) };
  if (type === CosmeticType.Badge) return { url: imageUrl, animated: !!animated };
  return { url: imageUrl };
};

/**
 * Resolves the `Cosmetic.data` write for an edit. Replaced artwork rebuilds the
 * blob; an offsets- or slug-only edit patches the existing one. Returns
 * undefined when nothing in `data` changed, so the caller can skip the write.
 */
export const patchCosmeticData = ({
  existingData,
  artworkData,
  offsetsChange,
  slugChange,
  usesChange,
  nextOffsets,
  nextSlug,
  nextUses,
}: {
  existingData: Record<string, unknown>;
  artworkData?: Record<string, unknown>;
  offsetsChange?: boolean;
  slugChange?: boolean;
  usesChange?: boolean;
  nextOffsets?: CosmeticOffsets | null;
  nextSlug?: string;
  nextUses?: number;
}) => {
  if (artworkData) return artworkData;
  if (!offsetsChange && !slugChange && !usesChange) return undefined;

  const { offsets: _prevOffsets, ...restData } = existingData;
  return {
    ...restData,
    ...(nextOffsets ? { offsets: nextOffsets } : {}),
    ...(nextSlug ? { slug: nextSlug } : {}),
    ...(nextUses ? { uses: nextUses } : {}),
  };
};

/**
 * What a creator gets of their own cosmetic on approval.
 *
 * Stickers get a finite balance — 10x what a buyer receives — because unlimited
 * was never chosen, it was what NULL happened to mean. Everything else keeps
 * granting NULL: `uses` is sticker-specific and a badge has nothing to consume.
 *
 * Throws rather than guessing when a sticker has no usable `uses`. That state
 * shouldn't exist (it also gives *buyers* an unlimited balance, since the
 * purchase grant reads the same field), so inventing a number here would hide a
 * data fault behind a plausible-looking grant.
 */
export function creatorGrantRemaining(type: CosmeticType, data: unknown): number | null {
  if (type !== CosmeticType.Sticker) return null;
  const uses = stickerUsesFromCosmeticData(data);
  if (!uses)
    throw new Error('Cannot approve a sticker without a positive integer `uses` in its data');
  return uses * CREATOR_GRANT_USES_MULTIPLIER;
}
