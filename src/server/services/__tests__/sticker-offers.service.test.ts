import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    cosmeticFindMany: vi.fn(),
    shopItemFindMany: vi.fn(),
    getBlockedPairIds: vi.fn(),
  },
}));

vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: mocks.getBlockedPairIds,
}));

// No `vi.mock` of shared modules here on purpose: the canonical mocks in
// `src/__tests__/setup.ts` already cover this file's import graph, and a local
// one freezes its shape into every later file in the same worker.
import { getStickerOffers } from '../sticker.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

dbMock.dbRead.cosmetic.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmeticShopItem.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindMany as (...a: unknown[]) => unknown)(...args)
);

const COSMETIC_ID = 11;
const VIEWER_ID = 5;
const CREATOR_ID = 90;

const cosmeticRow = (
  data: Record<string, unknown> = { pricePerUse: 5, uses: 100 },
  createdById: number | null = CREATOR_ID
) => ({
  id: COSMETIC_ID,
  data,
  createdById,
  creator: { username: 'maker' },
});

const listingRow = (over: Record<string, unknown> = {}) => ({
  id: 77,
  cosmeticId: COSMETIC_ID,
  unitAmount: 666,
  meta: {},
  availableQuantity: null,
  addedById: CREATOR_ID,
  _count: { purchases: 0 },
  ...over,
});

const offers = () => getStickerOffers({ ids: [COSMETIC_ID], viewerId: VIEWER_ID });

describe('getStickerOffers', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.cosmeticFindMany.mockResolvedValue([cosmeticRow()]);
    mocks.shopItemFindMany.mockResolvedValue([listingRow()]);
    mocks.getBlockedPairIds.mockResolvedValue([]);
  });

  it('reports the per-use price, the maker and the live listing', async () => {
    const [offer] = await offers();
    expect(offer).toEqual({
      cosmeticId: COSMETIC_ID,
      pricePerUse: 5,
      creatorUsername: 'maker',
      listing: {
        shopItemId: 77,
        unitAmount: 666,
        acceptsBlue: false,
        uses: 100,
        viaShopUserId: CREATOR_ID,
      },
    });
  });

  // Both halves are separately real states, and a buyer sees the same thing
  // either way: no price to offer for another batch.
  it('offers no listing when the sticker is not currently on sale', async () => {
    mocks.shopItemFindMany.mockResolvedValue([]);
    const [offer] = await offers();
    expect(offer.listing).toBeNull();
    // The top-up half is independent of the listing and survives it.
    expect(offer.pricePerUse).toBe(5);
  });

  // A capped listing whose stock is gone is not on sale, whatever the row says —
  // and the purchase would refuse, so showing its price would be a lie the buyer
  // only discovers by pressing.
  it('offers no listing when a capped one has sold out', async () => {
    // Counted from purchase ROWS, like the purchase does. `meta.purchases` is
    // written from a snapshot read and loses increments under concurrency, so a
    // sold-out listing still reads as available through it.
    mocks.shopItemFindMany.mockResolvedValue([
      listingRow({ availableQuantity: 5, _count: { purchases: 5 }, meta: { purchases: 1 } }),
    ]);
    const [offer] = await offers();
    expect(offer.listing).toBeNull();
  });

  it('keeps a capped listing that still has stock', async () => {
    mocks.shopItemFindMany.mockResolvedValue([
      listingRow({ availableQuantity: 5, _count: { purchases: 4 } }),
    ]);
    const [offer] = await offers();
    expect(offer.listing).toMatchObject({ shopItemId: 77 });
  });

  it('carries the listing Blue Buzz opt-in through', async () => {
    mocks.shopItemFindMany.mockResolvedValue([listingRow({ meta: { acceptsBlueBuzz: true } })]);
    const [offer] = await offers();
    expect(offer.listing?.acceptsBlue).toBe(true);
  });

  // A sticker sold before per-use pricing existed has no top-up price, and the
  // listing price is not a stand-in for one.
  it('reports a null per-use price rather than inventing one', async () => {
    mocks.cosmeticFindMany.mockResolvedValue([cosmeticRow({ uses: 100 })]);
    const [offer] = await offers();
    expect(offer.pricePerUse).toBeNull();
    expect(offer.listing).toMatchObject({ unitAmount: 666 });
  });

  // Each of these is a refusal `purchaseCosmeticShopItem` makes. Offering a
  // price it would reject is the one thing this function must not do.
  it('offers no listing to the sticker maker, who is granted it and cannot buy it', async () => {
    mocks.cosmeticFindMany.mockResolvedValue([cosmeticRow(undefined, VIEWER_ID)]);
    const [offer] = await offers();
    expect(offer.listing).toBeNull();
    // The per-use half is a different purchase and stays open.
    expect(offer.pricePerUse).toBe(5);
  });

  it('offers no listing across a block with the maker', async () => {
    mocks.getBlockedPairIds.mockResolvedValue([CREATOR_ID]);
    const [offer] = await offers();
    expect(offer.listing).toBeNull();
  });

  it('offers no listing across a block with whoever listed it', async () => {
    mocks.cosmeticFindMany.mockResolvedValue([cosmeticRow(undefined, 123)]);
    mocks.shopItemFindMany.mockResolvedValue([listingRow({ addedById: 456 })]);
    mocks.getBlockedPairIds.mockResolvedValue([456]);
    const [offer] = await offers();
    expect(offer.listing).toBeNull();
  });

  it('only asks for published, listed, in-window items', async () => {
    await offers();
    const { where } = mocks.shopItemFindMany.mock.calls[0][0];
    expect(where).toMatchObject({ status: 'Published', listed: true });
    expect(where.AND).toHaveLength(2);
  });
});
