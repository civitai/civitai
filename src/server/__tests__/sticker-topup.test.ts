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
const logToAxiom = vi.fn();

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
// Returns a promise, like the real one — which awaits its ingest with no
// internal guard, so a degraded Axiom rejects.
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => logToAxiom(...args),
}));

const { purchaseStickerUses } = await import('~/server/services/sticker.service');

// Every quantity in scope is a different number, so no assertion can confuse
// two things the code could plausibly have read: the buyer, the creator and the
// reseller are distinct ids, and the per-use price is deliberately NOT the floor
// (a fixture at the floor cannot tell "read the creator's price" from "fell back
// to the minimum"). Fixtures that collide are how a test comes to pass for the
// wrong reason.
const BUYER = 7;
const CREATOR = 99;
const RESELLER = 55;
const COSMETIC_ID = 12;
const PRICE_PER_USE = 25;

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
      logToAxiom,
    ])
      fn.mockReset();
    logToAxiom.mockResolvedValue(undefined);

    findCosmetic.mockResolvedValue({
      id: COSMETIC_ID,
      name: 'party cat',
      type: 'Sticker',
      createdById: CREATOR,
      data: { slug: 'party_cat', url: 'img', uses: 100, pricePerUse: PRICE_PER_USE },
    });
    // Listed by a reseller rather than by its creator: the interesting shape,
    // not the degenerate one where both ids are the same person.
    findListing.mockResolvedValue({
      id: 3,
      cosmeticId: COSMETIC_ID,
      meta: {},
      addedById: RESELLER,
    });
    // Plain, not a `Once` chain: tests that care about the difference between
    // the pre-charge read and the post-grant one queue their own, and a default
    // chain here would be consumed before theirs ever ran.
    findHoldings.mockResolvedValue([{ remaining: 0 }]);
    getBlockedPairIds.mockResolvedValue([]);
    queryRaw.mockResolvedValue([{ remaining: 10 }]);
    createMultiAccountBuzzTransaction.mockResolvedValue({
      transactionCount: 1,
      transactionIds: [{ accountType: 'yellow', amount: 250 }],
    });
    createBuzzTransaction.mockResolvedValue({ transactionId: 'tx' });
    refreshOwnedStickerCache.mockResolvedValue(undefined);
  });

  // A sticker sold only inside packs has no listing of its own. Without this the
  // top-up refuses and "packs inherit per-use pricing" is decorative.
  describe('authorised by a pack rather than its own listing', () => {
    // Distinct from COSMETIC_ID so the code can tell which listing it found; a
    // fixture that reused the id could not fail this test.
    const PACK_COSMETIC_ID = null;
    const PACK_BUILDER = 4242;
    const asPackListing = () =>
      findListing.mockResolvedValue({
        id: 77,
        cosmeticId: PACK_COSMETIC_ID,
        meta: { acceptsBlueBuzz: true },
        addedById: PACK_BUILDER,
      });

    it('tops up a holding that only a pack sells', async () => {
      asPackListing();
      await call();
      expect(createMultiAccountBuzzTransaction).toHaveBeenCalled();
      expect(queryRaw).toHaveBeenCalled();
    });

    // Asserted on the query itself, not just on what follows: every other test
    // here mocks the lookup's result, so narrowing it back to the sticker's own
    // listing would leave them all green while pack-only stickers stopped
    // resolving in production.
    it('looks for a pack containing the sticker, not only its own listing', async () => {
      asPackListing();
      await call();
      expect(findListing.mock.calls[0][0].where.OR).toEqual([
        { cosmeticId: COSMETIC_ID },
        { members: { some: { cosmeticId: COSMETIC_ID } } },
      ]);
    });

    it('refuses Blue Buzz, since the opt-in belongs to the pack builder not the creator', async () => {
      asPackListing();
      await expect(call({ payWith: 'blue-first' })).rejects.toThrow(/Blue Buzz/i);
      expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    });

    it('does not refuse on a block against the pack builder, who is not part of this sale', async () => {
      asPackListing();
      getBlockedPairIds.mockResolvedValue([PACK_BUILDER]);
      await call();
      expect(createMultiAccountBuzzTransaction).toHaveBeenCalled();
    });

    it('still refuses on a block against the sticker creator, who is paid', async () => {
      asPackListing();
      getBlockedPairIds.mockResolvedValue([CREATOR]);
      await expect(call()).rejects.toThrow(/no longer available/i);
      expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    });
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

  // Both sellers are checked, and they are different people in these fixtures —
  // with one id standing for both, dropping either check stays green while a
  // block against the reseller silently goes unenforced.
  it('refuses a block against the sticker creator', async () => {
    getBlockedPairIds.mockResolvedValue([CREATOR]);
    await expect(call()).rejects.toThrow(/no longer available/i);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses a block against the reseller who listed it', async () => {
    getBlockedPairIds.mockResolvedValue([RESELLER]);
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
    findListing.mockResolvedValue({
      id: 3,
      cosmeticId: COSMETIC_ID,
      meta: { acceptsBlueBuzz: true },
      addedById: CREATOR,
    });
    await call({ payWith: 'blue-first' });
    expect(createMultiAccountBuzzTransaction.mock.calls[0][0].fromAccountTypes).toEqual([
      'blue',
      'yellow',
    ]);
  });

  it('charges the per-use price times the quantity', async () => {
    await call({ quantity: 10 });
    expect(createMultiAccountBuzzTransaction.mock.calls[0][0].amount).toBe(250);
  });

  // Reads the statement rather than running it — no database here — but reads
  // it structurally: a bare `toContain('COALESCE')` also passes for
  // `SET "remaining" = <quantity>`, which clobbers balance a buyer paid for.
  // Mutation-tested: that clobber fails this test and only this test.
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
    // Three rows summing to 19 — deliberately not `firstRead + quantity`, which
    // 6 + 10 = 16 would satisfy without summing anything.
    findHoldings
      .mockResolvedValueOnce([{ remaining: 6 }])
      .mockResolvedValueOnce([{ remaining: 6 }, { remaining: 10 }, { remaining: 3 }]);
    const result = await call({ quantity: 10 });
    expect(result.remaining).toBe(19);
    expect(refreshOwnedStickerCache).toHaveBeenCalledWith([BUYER]);
  });

  // Counted and summed, not "find the first one that looks right": paying the
  // creator twice is the mint case, and a `.find()` assertion cannot see it.
  it('pays the creator their 70% pool exactly once, with no seller share', async () => {
    await call({ quantity: 10 });
    const payouts = createBuzzTransaction.mock.calls.map((c) => c[0]);
    expect(payouts).toHaveLength(1);
    expect(payouts[0].toAccountId).toBe(CREATOR);
    expect(payouts.reduce((sum, p) => sum + p.amount, 0)).toBe(175);
    // Never more than was collected, whatever the split.
    expect(payouts.reduce((sum, p) => sum + p.amount, 0)).toBeLessThanOrEqual(250);
  });

  // Asserts WHICH colour gets which share, not just that both appear. Blue is
  // free, non-bankable Buzz and yellow is real money, so transposing the two
  // pays a creator play money for what they earned — silently, per sale, in
  // proportion to how much blue the buyer happened to spend.
  it('pays each colour its own share of a blue-funded purchase', async () => {
    findListing.mockResolvedValue({
      id: 3,
      cosmeticId: COSMETIC_ID,
      meta: { acceptsBlueBuzz: true },
      addedById: RESELLER,
    });
    createMultiAccountBuzzTransaction.mockResolvedValue({
      transactionCount: 2,
      transactionIds: [
        { accountType: 'blue', amount: 100 },
        { accountType: 'yellow', amount: 150 },
      ],
    });

    await call({ quantity: 10, payWith: 'blue-first' });

    const payouts = createBuzzTransaction.mock.calls.map((c) => c[0]);
    // 175 pool, 100/250 of the purchase funded in blue → floor(175 × 100/250).
    expect(Object.fromEntries(payouts.map((p) => [p.toAccountType, p.amount]))).toEqual({
      blue: 70,
      yellow: 105,
    });
    expect(payouts.reduce((sum, p) => sum + p.amount, 0)).toBe(175);
  });

  // The floor case, executed rather than reasoned: one use at the minimum is
  // where integer rounding actually bites.
  it('never pays out more than it collected at the per-use floor', async () => {
    findCosmetic.mockResolvedValue({
      id: COSMETIC_ID,
      name: 'party cat',
      type: 'Sticker',
      createdById: CREATOR,
      data: { slug: 'party_cat', url: 'img', uses: 100, pricePerUse: 5 },
    });
    await call({ quantity: 1 });
    const charged = createMultiAccountBuzzTransaction.mock.calls[0][0].amount;
    const paid = createBuzzTransaction.mock.calls.reduce((sum, c) => sum + c[0].amount, 0);
    expect(charged).toBe(5);
    expect(paid).toBe(3);
    expect(paid).toBeLessThan(charged);
  });

  // `transactionCount` is the sole check that money actually moved. Whether the
  // external service counts a conflicted (already-charged) transaction toward it
  // is not knowable in this repo — this pins which field the code trusts, so the
  // assumption is written down rather than implied by fixtures that keep the two
  // in agreement.
  it('refuses when the count says nothing moved, whatever ids came back', async () => {
    createMultiAccountBuzzTransaction.mockResolvedValue({
      transactionCount: 0,
      transactionIds: [{ accountType: 'yellow', amount: 250 }],
    });
    await expect(call()).rejects.toThrow(/error creating the transaction/i);
    expect(queryRaw).not.toHaveBeenCalled();
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
    await expect(call({ expectedPricePerUse: PRICE_PER_USE })).resolves.toBeTruthy();
  });

  // Everything between the grant committing and the payout is bookkeeping. Any
  // of it throwing would charge the buyer, grant the uses, skip the creator's
  // 70%, and surface as a failed purchase — so each step gets its own case.
  it('still pays the creator when the cache refresh throws', async () => {
    refreshOwnedStickerCache.mockRejectedValue(new Error('redis down'));
    await expect(call({ quantity: 10 })).resolves.toBeTruthy();
    expect(createBuzzTransaction).toHaveBeenCalled();
  });

  // Both failures co-occur precisely during a multi-service incident: the
  // logger awaits its ingest with no internal guard, so a degraded Axiom hands
  // back a rejecting promise inside the very catch that exists to keep the
  // payout reachable.
  it('survives a rejecting logger inside the bookkeeping catch', async () => {
    // Kills the `await logToAxiom(...)` mutant: an awaited rejection escapes
    // the catch block and rejects the whole call. It does NOT kill a deleted
    // `.catch()` — vitest absorbs the rejection that would end the process
    // under Node — which is what the sibling test below is for.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      findHoldings
        .mockResolvedValueOnce([{ remaining: 0 }])
        .mockRejectedValueOnce(new Error('pool timeout'));
      logToAxiom.mockRejectedValue(new Error('axiom down'));

      await expect(call({ quantity: 10 })).resolves.toBeTruthy();
      expect(createBuzzTransaction).toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // The observable seam is whether a handler is ATTACHED, which this code owns
  // — not whether the process survives, which belongs to Node and the harness.
  // Asserts shape, not absorption: absorption is a language guarantee once
  // `.catch` is attached, so that is the right place to stop.
  it('attaches a handler to the logger it calls from a catch block', async () => {
    const axiomCatch = vi.fn(() => undefined);
    logToAxiom.mockReturnValue({ catch: axiomCatch });
    findHoldings
      .mockResolvedValueOnce([{ remaining: 0 }])
      .mockRejectedValueOnce(new Error('pool timeout'));

    await call({ quantity: 10 });

    expect(logToAxiom).toHaveBeenCalled();
    expect(axiomCatch).toHaveBeenCalled();
  });

  it('still pays the creator when the post-grant balance read throws', async () => {
    findHoldings
      .mockResolvedValueOnce([{ remaining: 0 }])
      .mockRejectedValueOnce(new Error('pool timeout'));
    await expect(call({ quantity: 10 })).resolves.toBeTruthy();
    expect(createBuzzTransaction).toHaveBeenCalled();
  });

  it('falls back to the top-up row when the balance read fails', async () => {
    // The row holds 14 — 4 left over from an earlier top-up plus the 10 just
    // bought — so falling back to `quantity` instead of the row's own balance
    // would report 10 and fail here. Equal numbers could not tell them apart.
    queryRaw.mockResolvedValue([{ remaining: 14 }]);
    findHoldings
      .mockResolvedValueOnce([{ remaining: 4 }])
      .mockRejectedValueOnce(new Error('pool timeout'));
    const result = await call({ quantity: 10 });
    expect(result.remaining).toBe(14);
  });

  // A creator topping up their own sticker would otherwise send 70% back to
  // themselves and burn the other 30% to do it.
  it('charges a creator for their own sticker but pays them nothing', async () => {
    findCosmetic.mockResolvedValue({
      id: COSMETIC_ID,
      name: 'party cat',
      type: 'Sticker',
      createdById: BUYER,
      data: { slug: 'party_cat', url: 'img', uses: 100, pricePerUse: PRICE_PER_USE },
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

  // The one path where the buyer is genuinely out of pocket. Retried, and it
  // must leave a trace carrying the transaction id — a silent failure here is
  // money gone with nothing to reconcile against.
  it('retries a failing refund and records it with the transaction id', async () => {
    queryRaw.mockRejectedValue(new Error('deadlock'));
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz service down'));

    await expect(call()).rejects.toThrow(/Failed to buy/i);

    expect(refundMultiAccountTransaction.mock.calls.length).toBeGreaterThan(1);
    const logged = logToAxiom.mock.calls.find((c) =>
      (c[0] as { message?: string }).message?.includes('refund failed')
    );
    expect(logged).toBeDefined();
    const charged = createMultiAccountBuzzTransaction.mock.calls[0][0].externalTransactionIdPrefix;
    expect((logged?.[0] as { data?: { transactionId?: string } }).data?.transactionId).toBe(
      charged
    );
  });

  // The buyer's error must describe their problem, not the refund's.
  it('reports the purchase failure rather than the refund failure', async () => {
    queryRaw.mockRejectedValue(new Error('deadlock'));
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz service down'));
    await expect(call()).rejects.toThrow(/Failed to buy sticker uses/i);
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
