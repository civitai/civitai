import { describe, expect, it } from 'vitest';
import { COSMETIC_STANDARDS } from '~/components/CreatorShop/Submit/standards.constants';
import {
  cosmeticDimensionsLabel,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { STICKER_SIZE } from '~/shared/utils/sticker-token';

describe('sticker design standards', () => {
  const labels = (COSMETIC_STANDARDS[CosmeticType.Sticker]?.requirements ?? []).map((r) => r.label);
  const requirement = cosmeticImageRequirements(CosmeticType.Sticker);
  const enforced = cosmeticDimensionsLabel(requirement);

  // The standards popover sits beside the artwork check on the submit form. A
  // hand-typed "Exactly 128x128" there told creators to upload art the check rejects.
  it('states the size the upload check enforces', () => {
    expect(labels.filter((l) => l.startsWith(enforced))).toHaveLength(1);
  });

  // The shipped bug was a shape claim ("Square keeps it aligned") as much as a size.
  it('states no size or shape but the enforced upload rule and the inline render height', () => {
    const inline = new RegExp(String.raw`\b${STICKER_SIZE.inline}px\b`);
    const sizeOrShape =
      /\d+[\s-]*(?:px|pixels?)\b|\d+\s*(?:[x×✕*]|by)\s*\d+|\d+\s*:\s*\d+|\bsquare\b/i;
    const stray = labels.filter((l) =>
      sizeOrShape.test(l.replace(enforced, '').replace(inline, ''))
    );
    expect(stray).toEqual([]);
  });

  it('asks for transparency exactly when the upload check requires it', () => {
    expect(labels.some((l) => l.includes('transparent background'))).toBe(
      requirement.requireTransparency
    );
  });
});
