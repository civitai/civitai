import { describe, expect, it } from 'vitest';
import { refillFromOffer } from '~/components/Sticker/sticker.util';

/**
 * The top-up gate itself — the part the duplicate action's F3 fix actually
 * changed, and which was asserted only through a spy until a review pointed out
 * that the arithmetic was covered and the thing it called was not.
 */
const listing = {
  shopItemId: 7,
  unitAmount: 500,
  acceptsBlue: true,
  uses: 20,
  viaShopUserId: 88,
};

describe('the top-up gate built from an offer', () => {
  it('carries the listing as a pack the draft can buy', () => {
    const gate = refillFromOffer({ pricePerUse: 25, creatorUsername: 'maker', listing });

    expect(gate).toEqual({
      refill: true,
      perUse: 25,
      pack: { shopItemId: 7, unitAmount: 500, acceptsBlue: true, uses: 20, viaShopUserId: 88 },
      creatorUsername: 'maker',
    });
  });

  /**
   * 🔴 THE FIX. `purchase` is snapshotted onto the draft and never recomputed, so
   * a gate built before the offers query resolves is the one that draft keeps.
   * Without the owned price standing in, it renders as "this sticker sells no
   * extra uses" — false, and permanent.
   */
  it('falls back to the owned price while the offers are still loading', () => {
    expect(refillFromOffer(undefined, 25)).toMatchObject({ refill: true, perUse: 25 });
  });

  it('prefers the offer price over the owned one once it lands', () => {
    const gate = refillFromOffer({ pricePerUse: 30, creatorUsername: null, listing: null }, 25);

    expect(gate.perUse).toBe(30);
  });

  /**
   * A real state rather than a bug: a sticker sold before per-use pricing and
   * since delisted cannot be topped up at all. The draft says so instead of
   * showing a button that fails.
   */
  it('is a dead end when there is no price and nothing on sale', () => {
    expect(refillFromOffer({ pricePerUse: null, creatorUsername: 'maker', listing: null })).toEqual(
      {
        refill: true,
        perUse: undefined,
        creatorUsername: 'maker',
      }
    );
  });

  it('credits nobody until the offer is known', () => {
    expect(refillFromOffer(undefined).creatorUsername).toBeUndefined();
  });

  it('normalises a null storefront rather than passing it through', () => {
    const gate = refillFromOffer({
      pricePerUse: 25,
      creatorUsername: 'maker',
      listing: { ...listing, viaShopUserId: null },
    });

    expect(gate.pack?.viaShopUserId).toBeUndefined();
  });
});
