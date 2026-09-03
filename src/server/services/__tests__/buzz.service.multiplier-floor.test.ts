import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getMultipliersForUser` is where the reward pipeline reads the multiplier it pays with.
 *
 * The `globalRewardsBonus` half has been finite-checked and clamped to [1, 5] for a while, which is
 * exactly what makes this easy to miss: anyone reading the function sees a guard and concludes the
 * path is covered. The `rewardsMultiplier` it multiplies BY comes from operator-authored
 * `Product.metadata` and had no floor at all (ClickUp 868m06pn5).
 *
 * `foldUserMultipliers` floors on the way into the cache, so these cases only arise from an entry
 * cached before that shipped — `userMultipliersCache` has a 1-day TTL — or from any future path
 * that populates the cache without going through the fold. That is the whole reason to floor twice.
 *
 * Rewards only. `purchasesMultiplier` is deliberately NOT floored here: it feeds
 * `getBuzzBulkMultiplier`, where a 0 credits a paid Buzz purchase with nothing.
 */

import type * as BuzzClient from '@civitai/buzz';
import type * as Caches from '~/server/redis/caches';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  createTransaction: vi.fn(),
  getTransactionByExternalId: vi.fn(),
  getAccount: vi.fn(),
  // `deleteMultipliersForUserCache` calls `.refresh` on the `refresh = true` branch. Absent, that
  // branch dies as "refresh is not a function" instead of a named assertion.
  refresh: vi.fn(),
  getActiveRewardsBonusEvent: vi.fn(async () => null as null | { multiplier: number }),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userMultipliersCache: { fetch: h.fetch, refresh: h.refresh },
}));

// Spread the real package and override only the client factory — a hand-listed factory would
// couple this file to every export buzz.service happens to import from it.
vi.mock('@civitai/buzz', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzClient>()),
  createBuzzClient: () => ({
    createTransaction: (...args: any[]) => h.createTransaction(...args),
    getTransactionByExternalId: (...args: any[]) => h.getTransactionByExternalId(...args),
    getAccount: (...args: any[]) => h.getAccount(...args),
  }),
}));

vi.mock('~/server/services/rewards-bonus-event.service', () => ({
  getActiveRewardsBonusEvent: () => h.getActiveRewardsBonusEvent(),
}));

import { claimBuzz, getMultipliersForUser } from '~/server/services/buzz.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER = 77;

const cached = (rewardsMultiplier: number) =>
  h.fetch.mockResolvedValue({
    [USER]: {
      userId: USER,
      rewardsMultiplier,
      purchasesMultiplier: 1,
      rewardsIneligible: false,
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.getActiveRewardsBonusEvent.mockResolvedValue(null);
  h.getTransactionByExternalId.mockResolvedValue(null);
  h.createTransaction.mockResolvedValue({ transactionId: 'tx-1' });
  h.getAccount.mockResolvedValue({ balance: 1_000_000, lifetimeBalance: 1_000_000 });
});

describe('getMultipliersForUser floors the value it pays with', () => {
  it('floors a negative cached multiplier at 0', async () => {
    cached(-2);

    const result = await getMultipliersForUser(USER);

    expect(result.rewardsMultiplier).toBe(0);
    expect(result.baseRewardsMultiplier).toBe(0);
  });

  it('replaces a non-finite cached multiplier by sign', async () => {
    cached(Infinity);
    expect((await getMultipliersForUser(USER)).rewardsMultiplier).toBe(1);

    cached(NaN);
    expect((await getMultipliersForUser(USER)).rewardsMultiplier).toBe(1);

    cached(-Infinity);
    expect((await getMultipliersForUser(USER)).rewardsMultiplier).toBe(0);
  });

  it('still multiplies a floored base by an active bonus event', async () => {
    // This is the only cover for the line the fix rewrote: drop `* globalRewardsBonus` and it
    // prints `expected 4 to be 20`. It does NOT separate a floor-at-0 from a floor-at-1 — clamp(4)
    // is 4 under either — so do not read it as doing that.
    cached(4);
    // 200/10 = 20, ABOVE MAX_GLOBAL_BONUS. At the 20 this used to carry, the raw value was already
    // 2 — inside [1, 5] — so the bonus clamp was inert and deleting it changed nothing here.
    h.getActiveRewardsBonusEvent.mockResolvedValue({ multiplier: 200 } as any);

    const result = await getMultipliersForUser(USER);

    expect(result.baseRewardsMultiplier).toBe(4);
    expect(result.globalRewardsBonus).toBe(5);
    // The same 20x the `keeps no ceiling` test defends, arrived at independently.
    expect(result.rewardsMultiplier).toBe(20);
    // Positive control for the banner gate. Without it, NARROWING the gate hides the banner for
    // every user and every event with the whole suite green — the mirror of the `>= 1` case below.
    expect(result.rewardsBonusEvent?.multiplier).toBe(200);
  });

  // 🔴 THE DECISION THIS PINS. If you are here because you are adding a `clampRewardMultiplier` to
  // `purchasesMultiplier` for symmetry: don't. It feeds `getBuzzBulkMultiplier`, which is called
  // UNCONDITIONALLY unlike every UI consumer, and there `mainBuzzAdded = floor(amount * m - amount)`
  // — so a 0 makes `totalCustomBuzz` 0 and a completed Stripe/Paddle purchase credits NOTHING.
  // `completeStripeBuzzPurchase` then writes the `transactionId` its own early return uses as an
  // idempotency marker, so a retry can never repair it. A 0 means "earns nothing" on the rewards
  // side and nothing at all on the purchases side.
  //
  // The purchases repair landed where the arithmetic is, NOT here: `getBuzzBulkMultiplier` floors at
  // 1 (finite `Math.max(m, 1)`, no ceiling) — ClickUp 868m0axkg. So `getMultipliersForUser` still
  // must NOT floor: a second floor here would be redundant and would change what the award
  // computation and Redis Lua cap (other consumers of this value) see. This test keeps pinning that
  // absence; without it the reverted regression comes back green.
  //
  // Read the assertions knowing this: `clampRewardMultiplier` only alters negatives and non-finites,
  // so every value able to witness "not floored" is a value the downstream floor now neutralises on
  // the payment path. `-3` and `NaN` reach `getMultipliersForUser` unchanged and are clamped to 1 at
  // `getBuzzBulkMultiplier`. The test pins where the repair lives, not the health of this function.
  it('does NOT floor purchasesMultiplier — that is a different money path', async () => {
    h.fetch.mockResolvedValue({
      [USER]: {
        userId: USER,
        rewardsMultiplier: 1,
        purchasesMultiplier: -3,
        rewardsIneligible: false,
      },
    });

    expect((await getMultipliersForUser(USER)).purchasesMultiplier).toBe(-3);

    h.fetch.mockResolvedValue({
      [USER]: {
        userId: USER,
        rewardsMultiplier: 1,
        purchasesMultiplier: NaN,
        rewardsIneligible: false,
      },
    });

    expect((await getMultipliersForUser(USER)).purchasesMultiplier).toBeNaN();
  });

  it('does not let a bonus event make rewards WORSE, or stop them entirely', async () => {
    // The guard this file's header cites is three checks, and the fixture above only reaches the
    // ceiling. These are the other two, and both are silent site-wide money events:
    //   raw < 1  — every reward on the site halved by a "bonus" event
    //   NaN      — every amount NaN, which sendAward's own `> 0` filter drops: paying just stops
    cached(4);
    h.getActiveRewardsBonusEvent.mockResolvedValue({ multiplier: 5 } as any);
    expect((await getMultipliersForUser(USER)).globalRewardsBonus).toBe(1);

    h.getActiveRewardsBonusEvent.mockResolvedValue({ multiplier: NaN } as any);
    const result = await getMultipliersForUser(USER);
    expect(result.globalRewardsBonus).toBe(1);
    // The banner gate rides on the same number and had no coverage anywhere in the repo. At a bonus
    // of 1 there is nothing to advertise; `>= 1` here would announce a running event to every user
    // for an event that multiplies by nothing.
    expect(result.rewardsBonusEvent).toBeNull();
  });

  it('can return a NON-FINITE multiplier built from two finite floored factors', async () => {
    // 🔴 THE REASON THE SPENDING SITES CLAMP AT ALL. This function floors the BASE and then
    // multiplies; the product is never re-clamped. So "getMultipliersForUser already floors" is
    // true of its input and false of its output, and no read-side clamp can close it — the overflow
    // happens after. `String(Infinity)` reaching the Lua cap script is `tonumber` nil, which throws
    // out of `redis.eval` and into the user's mutation.
    //
    // Two earlier attempts to say why the clamps sit WHERE they do were wrong (a pending row read
    // back by `process` — impossible, `isProcessable = !isOnDemand`; and an audit trail for an
    // operator typo, which this PR's own read-side floor removed). `multiplierRaw` is still the
    // reason they are not at `apply`'s read, for THIS value — see base.reward.forid.test.ts. What
    // was missing was the reason to clamp at all, which is the overflow below.
    //
    // Closing condition: if `getMultipliersForUser` ever clamps its own product, this test is
    // UPDATED to assert that clamp, not deleted. Deleting it is how the spending-site clamps become
    // unexplained again.
    cached(1e308);
    h.getActiveRewardsBonusEvent.mockResolvedValue({ multiplier: 50 } as any);

    const result = await getMultipliersForUser(USER);

    expect(result.baseRewardsMultiplier).toBe(1e308);
    expect(result.globalRewardsBonus).toBe(5);
    // `toBe(Infinity)`, not `Number.isFinite(...)).toBe(false)`: the latter also passes if the key
    // stops being returned at all, and does not separate Infinity from NaN — and it is `Infinity`
    // specifically that reaches the Lua as a string `tonumber` cannot parse.
    expect(result.rewardsMultiplier).toBe(Infinity);
  });

  it('leaves a sub-1 multiplier alone', async () => {
    cached(0.5);

    expect((await getMultipliersForUser(USER)).rewardsMultiplier).toBe(0.5);
  });
});

describe('claimBuzz pays from a clamped multiplier', () => {
  // The FOURTH reader, and the only one outside base.reward.ts that moves money. It reads
  // `getMultipliersForUser` and multiplies a BuzzClaim amount by it, so it inherits the same
  // non-finite product every other site clamps against.
  const CLAIM_AMOUNT = 500;

  const claimable = () => {
    dbMock.dbWrite.buzzClaim.findUnique.mockResolvedValue({
      key: 'test-claim',
      title: 'Test claim',
      description: 'Test claim',
      amount: CLAIM_AMOUNT,
      accountType: 'User',
      useMultiplier: true,
      availableStart: null,
      availableEnd: null,
      limit: null,
      claimed: 0,
      transactionIdQuery: 'SELECT 1',
    } as any);
    dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([{ transactionId: 'ext-1' }]);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as any);
  };

  it('does not ask for a non-finite amount', async () => {
    claimable();
    cached(1e308);
    h.getActiveRewardsBonusEvent.mockResolvedValue({ multiplier: 50 } as any);

    await claimBuzz({ id: 'test-claim', userId: USER });

    const [payload] = h.createTransaction.mock.calls[0] as unknown as [{ amount: number }];
    expect(payload.amount).toBe(CLAIM_AMOUNT);
  });

  it('still applies a legitimate multiplier', async () => {
    // Negative control: without it the assertion above passes on an implementation that dropped the
    // multiplier entirely.
    claimable();
    cached(4);

    await claimBuzz({ id: 'test-claim', userId: USER });

    const [payload] = h.createTransaction.mock.calls[0] as unknown as [{ amount: number }];
    expect(payload.amount).toBe(CLAIM_AMOUNT * 4);
  });
});
