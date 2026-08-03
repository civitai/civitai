import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buzzPurchaseTypes } from '~/shared/constants/buzz.constants';
import { STICKER_TOPUP_CLAIM_KEY, STICKER_TOPUP_MAX_QUANTITY } from '~/shared/utils/sticker-token';

const findCosmetic = vi.fn();
const findListing = vi.fn();
const findHoldings = vi.fn();
const queryRaw = vi.fn();
const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();
const createBuzzTransaction = vi.fn();
const getBlockedPairIds = vi.fn();
const refreshOwnedStickerCache = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmetic: { findUnique: (...args: unknown[]) => findCosmetic(...args) },
    cosmeticShopItem: { findFirst: (...args: unknown[]) => findListing(...args) },
    userCosmetic: { findMany: (...args: unknown[]) => findHoldings(...args) },
  },
  dbWrite: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: (...args: unknown[]) =>
    createMultiAccountBuzzTransaction(...args),
  refundMultiAccountTransaction: (...args: unknown[]) => refundMultiAccountTransaction(...args),
  createBuzzTransaction: (...args: unknown[]) => createBuzzTransaction(...args),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: (...args: unknown[]) => getBlockedPairIds(...args),
}));
vi.mock('~/server/redis/caches', () => ({
  refreshOwnedStickerCache: (...args: unknown[]) => refreshOwnedStickerCache(...args),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

const { purchaseStickerUses } = await import('~/server/services/sticker.service');

const BUYER = 7;
const CREATOR = 99;
const COSMETIC_ID = 12;

const call = (overrides: Record<string, unknown> = {}) =>
  purchaseStickerUses({
    userId: BUYER,
    cosmeticId: COSMETIC_ID,
    quantity: 10,
    stickersEnabled: true,
    ...overrides,
  } as Parameters<typeof purchaseStickerUses>[0]);

describe('purchaseStickerUses', () => {
  beforeEach(() => {
    for (const fn of [
      findCosmetic,
      findListing,
      findHoldings,
      queryRaw,
      createMultiAccountBuzzTransaction,
      refundMultiAccountTransaction,
      createBuzzTransaction,
      getBlockedPairIds,
      refreshOwnedStickerCache,
    ])
      fn.mockReset();

    findCosmetic.mockResolvedValue({
      id: COSMETIC_ID,
      name: 'party cat',
      type: 'Sticker',
      createdById: CREATOR,
      data: { slug: 'party_cat', url: 'img', uses: 100, pricePerUse: 5 },
    });
    findListing.mockResolvedValue({ id: 3, meta: {}, addedById: CREATOR });
    findHoldings.mockResolvedValue([{ remaining: 0 }]);
    getBlockedPairIds.mockResolvedValue([]);
    queryRaw.mockResolvedValue([{ remaining: 10 }]);
    createMultiAccountBuzzTransaction.mockResolvedValue({
      transactionCount: 1,
      transactionIds: [{ accountType: 'yellow', amount: 50 }],
    });
    createBuzzTransaction.mockResolvedValue({ transactionId: 'tx' });
    refreshOwnedStickerCache.mockResolvedValue(undefined);
  });

  // Filtering is a list operation and refusing is not. This mutation takes a
  // cosmetic id, so hiding stickers from the picker guards nothing.
  it('refuses when the sticker flag is off, without charging', async () => {
    await expect(call({ stickersEnabled: false })).rejects.toThrow(/not available/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses a cosmetic that is not a sticker', async () => {
    findCosmetic.mockResolvedValue({
      id: COSMETIC_ID,
      name: 'badge',
      type: 'Badge',
      createdById: CREATOR,
      data: { pricePerUse: 5 },
    });
    await expect(call()).rejects.toThrow(/only stickers/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  // A sticker created before per-use pricing existed has no top-up price, and
  // the list price must never stand in for one.
  it('refuses a sticker with no per-use price', async () => {
    findCosmetic.mockResolvedValue({
      id: COSMETIC_ID,
      name: 'party cat',
      type: 'Sticker',
      createdById: CREATOR,
      data: { slug: 'party_cat', url: 'img', uses: 100 },
    });
    await expect(call()).rejects.toThrow(/additional uses/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses when no published listing exists', async () => {
    findListing.mockResolvedValue(null);
    await expect(call()).rejects.toThrow(/no longer available/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  // Delisted stays Published, so an existing owner can still refill. Archived
  // and never-published are excluded by the status filter — assert the filter
  // rather than the outcome, since the outcome is a mocked return value.
  it('looks the listing up by Published status only, so delisted still refills', async () => {
    await call();
    const where = findListing.mock.calls[0][0].where;
    expect(where.status).toBe('Published');
    expect(where).not.toHaveProperty('listed');
  });

  it('refuses when the buyer already has an unlimited holding', async () => {
    findHoldings.mockResolvedValue([{ remaining: 3 }, { remaining: null }]);
    await expect(call()).rejects.toThrow(/unlimited/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses a blocked pairing without revealing the block', async () => {
    getBlockedPairIds.mockResolvedValue([CREATOR]);
    await expect(call()).rejects.toThrow(/no longer available/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, STICKER_TOPUP_MAX_QUANTITY + 1])(
    'refuses a quantity of %s',
    async (quantity) => {
      await expect(call({ quantity })).rejects.toThrow(/between 1 and/i);
      expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    }
  );

  it('refuses Blue Buzz unless the listing opted in', async () => {
    await expect(call({ payWith: 'blue-first' })).rejects.toThrow(/Blue Buzz/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('accepts Blue Buzz when the listing opted in, draining blue first', async () => {
    findListing.mockResolvedValue({ id: 3, meta: { acceptsBlueBuzz: true }, addedById: CREATOR });
    await call({ payWith: 'blue-first' });
    expect(createMultiAccountBuzzTransaction.mock.calls[0][0].fromAccountTypes).toEqual([
      'blue',
      'yellow',
    ]);
  });

  it('charges the per-use price times the quantity', async () => {
    await call({ quantity: 10 });
    expect(createMultiAccountBuzzTransaction.mock.calls[0][0].amount).toBe(50);
  });

  it('credits the existing balance rather than granting a fresh one', async () => {
    const result = await call({ quantity: 10 });
    const sql = queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('COALESCE');
    expect(queryRaw.mock.calls[0]).toContain(STICKER_TOPUP_CLAIM_KEY);
    expect(result.remaining).toBe(10);
    expect(refreshOwnedStickerCache).toHaveBeenCalledWith([BUYER]);
  });

  it('pays the creator their 70% pool, with no seller share', async () => {
    await call({ quantity: 10 });
    const payout = createBuzzTransaction.mock.calls.find(
      (c) => c[0].type === 'Sell' || c[0].toAccountId === CREATOR
    );
    expect(payout?.[0].toAccountId).toBe(CREATOR);
    expect(payout?.[0].amount).toBe(35);
  });

  // A creator topping up their own sticker would otherwise send 70% back to
  // themselves and burn the other 30% to do it.
  it('charges a creator for their own sticker but pays them nothing', async () => {
    findCosmetic.mockResolvedValue({
      id: COSMETIC_ID,
      name: 'party cat',
      type: 'Sticker',
      createdById: BUYER,
      data: { slug: 'party_cat', url: 'img', uses: 100, pricePerUse: 5 },
    });
    await call({ quantity: 10 });
    expect(createMultiAccountBuzzTransaction).toHaveBeenCalled();
    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refunds the charge when the grant fails', async () => {
    queryRaw.mockRejectedValue(new Error('deadlock'));
    await expect(call()).rejects.toThrow(/Failed to buy/i);
    expect(refundMultiAccountTransaction).toHaveBeenCalled();
  });
});

// Paid Buzz is derived, never hand-listed: blue is not purchasable, so it can
// never become a top-up currency by someone typing it into a literal.
describe('paid Buzz derivation', () => {
  it('excludes blue from the purchasable set', () => {
    expect(buzzPurchaseTypes).not.toContain('blue');
    expect(buzzPurchaseTypes).toContain('yellow');
    expect(buzzPurchaseTypes).toContain('green');
  });
});
