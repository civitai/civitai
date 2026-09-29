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

  it('states no size but the enforced upload size and the inline render height', () => {
    const stray = labels.filter((l) =>
      /\d+\s*(px\b|(?:[x×]|by)\s*\d+)/i.test(
        l.replace(enforced, '').replace(`${STICKER_SIZE.inline}px`, '')
      )
    );
    expect(stray).toEqual([]);
  });

  it('asks for transparency exactly when the upload check requires it', () => {
    expect(labels.some((l) => l.includes('transparent background'))).toBe(
      requirement.requireTransparency
    );
  });
});
