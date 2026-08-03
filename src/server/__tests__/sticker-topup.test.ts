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

// Every read in this path decides whether to charge or how much, so none may
// come off the replica. `dbRead` throws rather than returning data: a lagging
// replica would charge yesterday's price, and that failure is invisible in a
// test that lets the read succeed.
const replicaForbidden = (what: string) => () => {
  throw new Error(`${what} must be read on the writer`);
};
vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmetic: { findUnique: replicaForbidden('the per-use price') },
    cosmeticShopItem: { findFirst: replicaForbidden('the listing') },
    userCosmetic: { findMany: replicaForbidden('holdings') },
  },
  dbWrite: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    cosmetic: { findUnique: (...args: unknown[]) => findCosmetic(...args) },
    cosmeticShopItem: { findFirst: (...args: unknown[]) => findListing(...args) },
    userCosmetic: { findMany: (...args: unknown[]) => findHoldings(...args) },
  },
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

  // Topping up refills; it does not acquire. Otherwise 5 Buzz buys ownership of
  // a sticker whose listing is sold out, or whose purchase guards would refuse.
  it('refuses to grant a holding to someone who owns none', async () => {
    findHoldings.mockResolvedValue([]);
    await expect(call()).rejects.toThrow(/Buy this sticker/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
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

  // Asserting the SQL *adds to* the stored value rather than replacing it, by
  // executing the statement's shape against a fake row. A `toContain('COALESCE')`
  // grep passes for `SET remaining = ${quantity}` too, which clobbers the
  // balance a buyer already paid for.
  it('adds to the stored balance rather than replacing it', async () => {
    await call({ quantity: 10 });
    const [strings, ...params] = queryRaw.mock.calls[0];
    const sql = (strings as string[]).join(' ? ');

    expect(sql).toContain('ON CONFLICT');
    expect(params).toContain(STICKER_TOPUP_CLAIM_KEY);

    // The DO UPDATE clause must reference the existing column, not just the
    // parameter — `SET "remaining" = ?` would pass a substring check.
    const doUpdate = sql.slice(sql.indexOf('DO UPDATE'));
    expect(doUpdate).toMatch(/COALESCE\(\s*"UserCosmetic"\."remaining"\s*,\s*0\s*\)\s*\+/);
    expect(doUpdate).not.toMatch(/COALESCE\(\s*excluded/i);
  });

  it('reports the balance across every holding, not just the top-up row', async () => {
    // A purchase row with 6 left plus the 10 just bought.
    findHoldings
      .mockResolvedValueOnce([{ remaining: 6 }])
      .mockResolvedValueOnce([{ remaining: 6 }, { remaining: 10 }]);
    const result = await call({ quantity: 10 });
    expect(result.remaining).toBe(16);
    expect(refreshOwnedStickerCache).toHaveBeenCalledWith([BUYER]);
  });

  // Counted and summed, not "find the first one that looks right": paying the
  // creator twice is the mint case, and a `.find()` assertion cannot see it.
  it('pays the creator their 70% pool exactly once, with no seller share', async () => {
    await call({ quantity: 10 });
    const payouts = createBuzzTransaction.mock.calls.map((c) => c[0]);
    expect(payouts).toHaveLength(1);
    expect(payouts[0].toAccountId).toBe(CREATOR);
    expect(payouts.reduce((sum, p) => sum + p.amount, 0)).toBe(35);
    // Never more than was collected, whatever the split.
    expect(payouts.reduce((sum, p) => sum + p.amount, 0)).toBeLessThanOrEqual(50);
  });

  it('splits a blue-funded payout across colours without paying out more', async () => {
    findListing.mockResolvedValue({ id: 3, meta: { acceptsBlueBuzz: true }, addedById: CREATOR });
    createMultiAccountBuzzTransaction.mockResolvedValue({
      transactionCount: 2,
      transactionIds: [
        { accountType: 'blue', amount: 20 },
        { accountType: 'yellow', amount: 30 },
      ],
    });
    await call({ quantity: 10, payWith: 'blue-first' });
    const payouts = createBuzzTransaction.mock.calls.map((c) => c[0]);
    expect(payouts.reduce((sum, p) => sum + p.amount, 0)).toBe(35);
    expect(payouts.map((p) => p.toAccountType).sort()).toEqual(['blue', 'yellow']);
  });

  // The floor case, executed rather than reasoned: 1 use at 5 Buzz is where
  // integer rounding actually bites.
  it('never pays out more than it collected at the per-use floor', async () => {
    await call({ quantity: 1 });
    const charged = createMultiAccountBuzzTransaction.mock.calls[0][0].amount;
    const paid = createBuzzTransaction.mock.calls.reduce((sum, c) => sum + c[0].amount, 0);
    expect(charged).toBe(5);
    expect(paid).toBe(3);
    expect(paid).toBeLessThan(charged);
  });

  // Two tabs, a retry, a double-click. A shop purchase can't repeat; a top-up
  // can, and a shared external id reads as "already paid" to the Buzz service.
  it('gives every top-up a distinct external transaction id', async () => {
    await call({ quantity: 1 });
    await call({ quantity: 1 });
    const [first, second] = createMultiAccountBuzzTransaction.mock.calls.map(
      (c) => c[0].externalTransactionIdPrefix
    );
    expect(first).not.toBe(second);
  });

  it('refuses when the price moved since the buyer was shown it', async () => {
    await expect(call({ expectedPricePerUse: 4 })).rejects.toThrow(/price changed/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('proceeds when the shown price still matches', async () => {
    await expect(call({ expectedPricePerUse: 5 })).resolves.toBeTruthy();
  });

  // A Redis blip must not read as a failed purchase, and must not swallow the
  // creator's payout by short-circuiting the rest of the function.
  it('still pays the creator when the cache refresh throws', async () => {
    refreshOwnedStickerCache.mockRejectedValue(new Error('redis down'));
    await expect(call({ quantity: 10 })).resolves.toBeTruthy();
    expect(createBuzzTransaction).toHaveBeenCalled();
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

  // Refunded once, and against the prefix that was actually charged — a refund
  // aimed at the wrong id leaves the buyer's Buzz gone.
  it('refunds exactly the charge it made when the grant fails', async () => {
    queryRaw.mockRejectedValue(new Error('deadlock'));
    await expect(call()).rejects.toThrow(/Failed to buy/i);
    const charged = createMultiAccountBuzzTransaction.mock.calls[0][0].externalTransactionIdPrefix;
    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(refundMultiAccountTransaction.mock.calls[0][0].externalTransactionIdPrefix).toBe(
      charged
    );
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
