import { describe, expect, it } from 'vitest';
import { buildData } from '~/components/CreatorShop/Submit/submit.util';
import {
  cosmeticImageRequirements,
  creatorCosmeticTypes,
  isCreatorCosmeticType,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

// The original P4 hole: the type was listable but the data builder had no Emoji
// branch, so a submission stored `{ url }` with no slug — purchasable, and
// unusable forever, because `useOwnedEmoji` drops any emoji without one.
describe('creator-shop emoji submission', () => {
  it('lists Emoji as a creator-submittable type', () => {
    expect(creatorCosmeticTypes).toContain(CosmeticType.Emoji);
    expect(isCreatorCosmeticType(CosmeticType.Emoji)).toBe(true);
  });

  it('builds cosmetic data carrying the slug, not just the url', () => {
    expect(buildData(CosmeticType.Emoji, 'cf-image-id', true, null, 'party_cat')).toEqual({
      url: 'cf-image-id',
      slug: 'party_cat',
      animated: true,
    });
  });

  it('requires exactly 128x128 with transparency', () => {
    expect(cosmeticImageRequirements(CosmeticType.Emoji)).toEqual({
      width: 128,
      height: 128,
      exact: true,
      requireTransparency: true,
    });
  });

  it('does not fall through to the Badge default for Emoji', () => {
    const emoji = cosmeticImageRequirements(CosmeticType.Emoji);
    const badge = cosmeticImageRequirements(CosmeticType.Badge);
    expect(emoji).not.toEqual(badge);
    expect(emoji.exact).toBe(true);
  });

  it('leaves the other creator types unchanged', () => {
    expect(buildData(CosmeticType.Badge, 'img', true, null, 'ignored')).toEqual({
      url: 'img',
      animated: true,
    });
  });
});
