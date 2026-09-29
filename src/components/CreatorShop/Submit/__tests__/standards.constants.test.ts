import { describe, expect, it } from 'vitest';
import { COSMETIC_STANDARDS } from '~/components/CreatorShop/Submit/standards.constants';
import {
  cosmeticDimensionsLabel,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

describe('sticker design standards', () => {
  const labels = (COSMETIC_STANDARDS[CosmeticType.Sticker]?.requirements ?? []).map((r) => r.label);

  // The standards popover sits beside the artwork check on the submit form. A
  // hand-typed "Exactly 128x128" there told creators to upload art the check rejects.
  it('states the size the upload check enforces', () => {
    const enforced = cosmeticDimensionsLabel(cosmeticImageRequirements(CosmeticType.Sticker));
    expect(labels.filter((l) => l.startsWith(enforced))).toHaveLength(1);
  });

  it('states no other pixel size', () => {
    const enforced = cosmeticDimensionsLabel(cosmeticImageRequirements(CosmeticType.Sticker));
    expect(labels.filter((l) => /\d+\s*[x×]\s*\d+/.test(l.replace(enforced, '')))).toEqual([]);
  });
});
