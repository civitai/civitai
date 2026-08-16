import type * as PromClient from '~/server/prom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    cosmeticFindMany: vi.fn(),
    shopItemFindMany: vi.fn(),
  },
}));

vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', () => ({ getBlockedPairIds: vi.fn() }));

import { getStickerOffers } from '../sticker.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

dbMock.dbRead.cosmetic.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmeticShopItem.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindMany as (...a: unknown[]) => unknown)(...args)
);

const COSMETIC_ID = 11;

const cosmeticRow = (data: Record<string, unknown> = { pricePerUse: 5, uses: 100 }) => ({
  id: COSMETIC_ID,
  data,
  creator: { username: 'maker' },
});

const listingRow = (over: Record<string, unknown> = {}) => ({
  id: 77,
  cosmeticId: COSMETIC_ID,
  unitAmount: 666,
  meta: {},
  availableQuantity: null,
  ...over,
});

describe('getStickerOffers', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.cosmeticFindMany.mockResolvedValue([cosmeticRow()]);
    mocks.shopItemFindMany.mockResolvedValue([listingRow()]);
  });

  it('asks for nothing when given no ids', async () => {
    expect(await getStickerOffers({ ids: [] })).toEqual([]);
    expect(mocks.cosmeticFindMany).not.toHaveBeenCalled();
  });

  it('reports the per-use price, the maker and the live listing', async () => {
    const [offer] = await getStickerOffers({ ids: [COSMETIC_ID] });
    expect(offer).toEqual({
      cosmeticId: COSMETIC_ID,
      pricePerUse: 5,
      creatorUsername: 'maker',
      listing: { shopItemId: 77, unitAmount: 666, acceptsBlue: false, uses: 100 },
    });
  });

  // Both halves are separately real states, and a buyer sees the same thing
  // either way: no price to offer for another batch.
  it('offers no listing when the sticker is not currently on sale', async () => {
    mocks.shopItemFindMany.mockResolvedValue([]);
    const [offer] = await getStickerOffers({ ids: [COSMETIC_ID] });
    expect(offer.listing).toBeNull();
    // The top-up half is independent of the listing and survives it.
    expect(offer.pricePerUse).toBe(5);
  });

  // A capped listing whose stock is gone is not on sale, whatever the row says —
  // and the purchase would refuse, so showing its price would be a lie the buyer
  // only discovers by pressing.
  it('offers no listing when a capped one has sold out', async () => {
    mocks.shopItemFindMany.mockResolvedValue([
      listingRow({ availableQuantity: 5, meta: { purchases: 5 } }),
    ]);
    const [offer] = await getStickerOffers({ ids: [COSMETIC_ID] });
    expect(offer.listing).toBeNull();
  });

  it('keeps a capped listing that still has stock', async () => {
    mocks.shopItemFindMany.mockResolvedValue([
      listingRow({ availableQuantity: 5, meta: { purchases: 4 } }),
    ]);
    const [offer] = await getStickerOffers({ ids: [COSMETIC_ID] });
    expect(offer.listing).toMatchObject({ shopItemId: 77 });
  });

  it('carries the listing Blue Buzz opt-in through', async () => {
    mocks.shopItemFindMany.mockResolvedValue([listingRow({ meta: { acceptsBlueBuzz: true } })]);
    const [offer] = await getStickerOffers({ ids: [COSMETIC_ID] });
    expect(offer.listing?.acceptsBlue).toBe(true);
  });

  // A sticker sold before per-use pricing existed has no top-up price, and the
  // listing price is not a stand-in for one.
  it('reports a null per-use price rather than inventing one', async () => {
    mocks.cosmeticFindMany.mockResolvedValue([cosmeticRow({ uses: 100 })]);
    const [offer] = await getStickerOffers({ ids: [COSMETIC_ID] });
    expect(offer.pricePerUse).toBeNull();
    expect(offer.listing).toMatchObject({ unitAmount: 666 });
  });

  it('only asks for published, listed, in-window items', async () => {
    await getStickerOffers({ ids: [COSMETIC_ID] });
    const { where } = mocks.shopItemFindMany.mock.calls[0][0];
    expect(where).toMatchObject({ status: 'Published', listed: true });
    expect(where.AND).toHaveLength(2);
  });
});
