import { describe, expect, it } from 'vitest';
import { buildCosmeticData, patchCosmeticData } from '~/server/services/creator-shop.data';
import {
  cosmeticImageRequirements,
  creatorCosmeticTypes,
  isCreatorCosmeticType,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

// `buildCosmeticData` is what writes `Cosmetic.data` on both the submit and the
// update path. The original P4 hole was a missing branch here — asserting on
// the client preview helper instead would let it reopen with tests still green.
describe('creator-shop emoji submission', () => {
  it('lists Emoji as a creator-submittable type', () => {
    expect(creatorCosmeticTypes).toContain(CosmeticType.Emoji);
    expect(isCreatorCosmeticType(CosmeticType.Emoji)).toBe(true);
  });

  it('writes the slug into cosmetic data, not just the url', () => {
    expect(buildCosmeticData(CosmeticType.Emoji, 'cf-image-id', true, null, 'party_cat')).toEqual({
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
    expect(emoji).not.toEqual(cosmeticImageRequirements(CosmeticType.Badge));
    expect(emoji.exact).toBe(true);
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
describe('creator-shop emoji update — data patching', () => {
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
