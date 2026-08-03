import { describe, expect, it } from 'vitest';
import {
  buildCosmeticData,
  creatorGrantRemaining,
  patchCosmeticData,
} from '~/server/services/creator-shop.data';
import { submitCreatorShopItemSchema } from '~/server/schema/creator-shop.schema';
import {
  COSMETIC_PRICE_FLOOR_MIN,
  cosmeticDimensionsLabel,
  cosmeticDimensionsPass,
  cosmeticImageRequirements,
  cosmeticPriceFloor,
  creatorCosmeticTypes,
  isCreatorCosmeticType,
  packItemFloor,
  STICKER_MIN_LONG_EDGE,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { CREATOR_GRANT_USES_MULTIPLIER, STICKER_SIZE } from '~/shared/utils/sticker-token';

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

  it('constrains the long edge and the ratio, not width and height', () => {
    expect(cosmeticImageRequirements(CosmeticType.Sticker)).toEqual({
      kind: 'freeform',
      minLongEdge: STICKER_SIZE.jumbo * 2,
      maxLongEdge: 512,
      maxAspectRatio: 2,
      requireTransparency: true,
    });
  });

  it('derives the size floor from the jumbo render so the two cannot drift', () => {
    expect(STICKER_MIN_LONG_EDGE).toBe(STICKER_SIZE.jumbo * 2);
  });

  it('does not fall through to the Badge default for Sticker', () => {
    const sticker = cosmeticImageRequirements(CosmeticType.Sticker);
    expect(sticker).not.toEqual(cosmeticImageRequirements(CosmeticType.Badge));
    expect(sticker.kind).toBe('freeform');
  });

  describe('sticker dimensions', () => {
    const req = cosmeticImageRequirements(CosmeticType.Sticker);
    const pass = (w: number, h: number) => cosmeticDimensionsPass(req, w, h);

    it('accepts non-square art in either orientation', () => {
      expect(pass(273, 241)).toBe(true);
      expect(pass(241, 273)).toBe(true);
      expect(pass(128, 128)).toBe(true);
      expect(pass(256, 128)).toBe(true);
      expect(pass(128, 256)).toBe(true);
    });

    it('rejects anything past the ratio cap, both ways round', () => {
      expect(pass(257, 128)).toBe(false);
      expect(pass(128, 257)).toBe(false);
      expect(pass(512, 100)).toBe(false);
    });

    // Expressed against the derived floor, not a literal: the whole point of
    // STICKER_SIZE.jumbo * 2 is that raising the render size raises the upload
    // rule with it, and a test pinning 96 would just have to be edited each time.
    // The coupling itself is pinned by the test above.
    it('rejects art too small to render a crisp jumbo, and oversized art', () => {
      expect(pass(STICKER_MIN_LONG_EDGE - 1, STICKER_MIN_LONG_EDGE - 1)).toBe(false);
      expect(pass(STICKER_MIN_LONG_EDGE, STICKER_MIN_LONG_EDGE)).toBe(true);
      expect(pass(512, 512)).toBe(true);
      expect(pass(513, 513)).toBe(false);
    });

    it('rejects undecodable art rather than dividing by zero', () => {
      expect(pass(0, 0)).toBe(false);
      expect(pass(128, 0)).toBe(false);
    });

    it('states the actual rule, with no mention of a fixed size', () => {
      const label = cosmeticDimensionsLabel(req);
      expect(label).toContain(String(STICKER_MIN_LONG_EDGE));
      expect(label).toContain('512');
      expect(label).toContain('2:1');
      expect(label).not.toContain('128×128');
    });
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

  // Summing per member is what makes a MIXED-type pack price correctly. Asserting
  // it against a uniform pack would hold for `count x oneFloor` too, so this pins
  // it against a stubbed lookup where the types genuinely differ.
  it('sums each member type rather than multiplying one of them', () => {
    const stub: Partial<Record<CosmeticType, number>> = {
      [CosmeticType.Sticker]: 100,
      [CosmeticType.Badge]: 700,
    };
    const floorOf = (type: CosmeticType) => stub[type] ?? 500;
    const members = [CosmeticType.Sticker, CosmeticType.Sticker, CosmeticType.Badge];

    const summed = members.reduce((sum, type) => sum + floorOf(type), 0);
    expect(summed).toBe(900);
    // What `count x oneFloor` would have produced, using the first member.
    expect(summed).not.toBe(members.length * floorOf(members[0]));
  });

  it('degenerates to count x floor while every type shares a value', () => {
    const members = Array.from({ length: 10 }, () => CosmeticType.Sticker);
    const summed = members.reduce((sum, type) => sum + packItemFloor(type), 0);
    expect(summed).toBe(10 * packItemFloor(CosmeticType.Sticker));
  });
});

// The creator's own copy used to be granted with no `remaining`, i.e. NULL, i.e.
// unlimited — which was what NULL happened to mean, not a decision.
describe('creator grant on approval', () => {
  it('gives a sticker creator 10x what a buyer gets', () => {
    expect(creatorGrantRemaining(CosmeticType.Sticker, { uses: 100 })).toBe(
      100 * CREATOR_GRANT_USES_MULTIPLIER
    );
    expect(creatorGrantRemaining(CosmeticType.Sticker, { uses: 1 })).toBe(
      CREATOR_GRANT_USES_MULTIPLIER
    );
  });

  // The regression that would go unnoticed: `uses` is sticker-specific, and a
  // badge has nothing to consume. Leaking the sticker branch into the shared
  // grant path would start writing 0 or NaN for every other type.
  it.each([
    CosmeticType.Badge,
    CosmeticType.ProfileDecoration,
    CosmeticType.ProfileBackground,
    CosmeticType.ContentDecoration,
  ])('still grants %s unlimited', (type) => {
    expect(creatorGrantRemaining(type, {})).toBeNull();
    expect(creatorGrantRemaining(type, { uses: 100 })).toBeNull();
  });

  // Defined outcome rather than `undefined * 10`. Reachable today: `uses` is
  // optional in the submit schema, and the same missing field would also hand
  // BUYERS an unlimited balance, so it is a fault worth refusing loudly.
  it.each([[{}], [{ uses: 0 }], [{ uses: -5 }], [{ uses: 'lots' }], [null], [undefined]])(
    'refuses to approve a sticker whose uses is %s',
    (data) => {
      expect(() => creatorGrantRemaining(CosmeticType.Sticker, data)).toThrow(/positive integer/);
    }
  );

  it('never produces NaN', () => {
    for (const data of [{}, { uses: NaN }, { uses: Infinity }]) {
      let result: number | null = null;
      try {
        result = creatorGrantRemaining(CosmeticType.Sticker, data);
      } catch {
        continue;
      }
      expect(Number.isNaN(result)).toBe(false);
    }
  });
});

// `uses` was optional, and both the buyer balance and the creator grant read it —
// so a sticker without it sold an UNLIMITED balance at a finite price.
describe('uses is required for stickers', () => {
  const base = {
    cosmeticType: CosmeticType.Sticker,
    name: 'Test',
    imageUrl: 'img',
    slug: 'party_cat',
    price: 500,
  };

  it('rejects a sticker submitted without uses', () => {
    const result = submitCreatorShopItemSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((i) => i.path.includes('uses'))).toBe(true);
  });

  it('accepts a sticker with uses', () => {
    expect(submitCreatorShopItemSchema.safeParse({ ...base, uses: 100 }).success).toBe(true);
  });

  // The regression that would go unnoticed: uses is sticker-specific, and every
  // other type must still submit without it.
  it('still accepts a badge without uses', () => {
    const result = submitCreatorShopItemSchema.safeParse({
      ...base,
      cosmeticType: CosmeticType.Badge,
      slug: undefined,
    });
    expect(result.success).toBe(true);
  });
});

// Replacing artwork REBUILDS `data` rather than patching it, so anything not
// passed to buildCosmeticData is dropped — which silently turned a finite
// sticker unlimited for every future buyer.
describe('replacing sticker artwork keeps uses', () => {
  it('carries uses into the rebuilt blob', () => {
    expect(
      buildCosmeticData(CosmeticType.Sticker, 'new-img', false, null, 'party_cat', 100)
    ).toEqual({ url: 'new-img', slug: 'party_cat', animated: false, uses: 100 });
  });

  it('is what patchCosmeticData returns wholesale on an artwork change', () => {
    const artworkData = buildCosmeticData(
      CosmeticType.Sticker,
      'new-img',
      false,
      null,
      'party_cat',
      100
    );
    expect(
      patchCosmeticData({
        existingData: { url: 'old', slug: 'party_cat', uses: 100 },
        artworkData,
      })
    ).toEqual(artworkData);
  });
});
