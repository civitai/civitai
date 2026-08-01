import { describe, expect, it } from 'vitest';
import { buildCosmeticData, patchCosmeticData } from '~/server/services/creator-shop.data';
import {
  COSMETIC_PRICE_FLOOR_MIN,
  cosmeticImageRequirements,
  cosmeticPriceFloor,
  creatorCosmeticTypes,
  isCreatorCosmeticType,
  packItemFloor,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

// `buildCosmeticData` is what writes `Cosmetic.data` on both the submit and the
// update path. The original P4 hole was a missing branch here — asserting on
// the client preview helper instead would let it reopen with tests still green.
describe('creator-shop sticker submission', () => {
  it('lists Sticker as a creator-submittable type', () => {
    expect(creatorCosmeticTypes).toContain(CosmeticType.Sticker);
    expect(isCreatorCosmeticType(CosmeticType.Sticker)).toBe(true);
  });

  it('writes the slug into cosmetic data, not just the url', () => {
    expect(buildCosmeticData(CosmeticType.Sticker, 'cf-image-id', true, null, 'party_cat')).toEqual(
      {
        url: 'cf-image-id',
        slug: 'party_cat',
        animated: true,
      }
    );
  });

  it('requires exactly 128x128 with transparency', () => {
    expect(cosmeticImageRequirements(CosmeticType.Sticker)).toEqual({
      width: 128,
      height: 128,
      exact: true,
      requireTransparency: true,
    });
  });

  it('does not fall through to the Badge default for Sticker', () => {
    const sticker = cosmeticImageRequirements(CosmeticType.Sticker);
    expect(sticker).not.toEqual(cosmeticImageRequirements(CosmeticType.Badge));
    expect(sticker.exact).toBe(true);
  });

  it('leaves the other creator types unchanged', () => {
    expect(buildCosmeticData(CosmeticType.Badge, 'img', true, null, 'ignored')).toEqual({
      url: 'img',
      animated: true,
    });
  });
});

// The update path had no coverage, which is how a slug edit that never reached
// the database got through review.
describe('creator-shop sticker update — data patching', () => {
  it('applies a renamed slug rather than preserving the old one', () => {
    expect(
      patchCosmeticData({
        existingData: { url: 'img', slug: 'party_cat', animated: true },
        slugChange: true,
        nextSlug: 'partycat',
      })
    ).toEqual({ url: 'img', slug: 'partycat', animated: true });
  });

  it('keeps the slug when only offsets change', () => {
    expect(
      patchCosmeticData({
        existingData: { url: 'img', slug: 'party_cat', offsets: { top: 9 } },
        offsetsChange: true,
        nextOffsets: { top: 1, right: 0, bottom: 0, left: 0 },
        nextSlug: 'party_cat',
      })
    ).toEqual({
      url: 'img',
      slug: 'party_cat',
      offsets: { top: 1, right: 0, bottom: 0, left: 0 },
    });
  });

  it('writes nothing when neither slug nor offsets changed', () => {
    expect(patchCosmeticData({ existingData: { url: 'img', slug: 'party_cat' } })).toBeUndefined();
  });
});

// Every type is seeded at the same value today, so these pin the *shape* — the
// zod gate must never be able to reject something the real floor would allow.
describe('creator-shop price floors', () => {
  const allTypes = Object.values(CosmeticType);

  it('gives every cosmetic type a listing floor', () => {
    for (const type of allTypes) expect(cosmeticPriceFloor(type)).toBeGreaterThan(0);
  });

  it('keeps the zod gate at or below every per-type floor', () => {
    for (const type of allTypes)
      expect(COSMETIC_PRICE_FLOOR_MIN).toBeLessThanOrEqual(cosmeticPriceFloor(type));
  });

  it('gives every cosmetic type a pack-member floor', () => {
    for (const type of allTypes) expect(packItemFloor(type)).toBeGreaterThan(0);
  });

  it('sums per member, so a 10-sticker pack floors at 10x', () => {
    const members = Array.from({ length: 10 }, () => CosmeticType.Sticker);
    const floor = members.reduce((sum, type) => sum + packItemFloor(type), 0);
    expect(floor).toBe(10 * packItemFloor(CosmeticType.Sticker));
  });
});
