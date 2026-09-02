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

import type * as Caches from '~/server/redis/caches';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  // `deleteMultipliersForUserCache` calls `.refresh` on the `refresh = true` branch. Absent, that
  // branch dies as "refresh is not a function" instead of a named assertion.
  refresh: vi.fn(),
  getActiveRewardsBonusEvent: vi.fn(async () => null as null | { multiplier: number }),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userMultipliersCache: { fetch: h.fetch, refresh: h.refresh },
}));

vi.mock('~/server/services/rewards-bonus-event.service', () => ({
  getActiveRewardsBonusEvent: () => h.getActiveRewardsBonusEvent(),
}));

import { getMultipliersForUser } from '~/server/services/buzz.service';

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
  });

  // 🔴 THE DECISION THIS PINS. If you are here because you are adding a `clampRewardMultiplier` to
  // `purchasesMultiplier` for symmetry: don't. It feeds `getBuzzBulkMultiplier`, which is called
  // UNCONDITIONALLY unlike every UI consumer, and there `mainBuzzAdded = floor(amount * m - amount)`
  // — so a 0 makes `totalCustomBuzz` 0 and a completed Stripe/Paddle/NowPayments purchase credits
  // NOTHING. `completeStripeBuzzPurchase` then writes the `transactionId` its own early return uses
  // as an idempotency marker, so a retry can never repair it. A 0 means "earns nothing" on the
  // rewards side and nothing at all on the purchases side. That path needs its own floor, decided
  // on its own terms. Without this test the reverted regression comes back green.
  //
  // Closing condition, so this does not become a wall: when the purchases path gets its own floor —
  // likely at 1, which delivers what was paid for — this test is UPDATED, not deleted. A floor at 0
  // is the one that pays nothing. Note also that every value able to witness "not floored" is a
  // value that must never reach the payment path, so the assertions below pin a hazard on purpose.
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
    expect((await getMultipliersForUser(USER)).globalRewardsBonus).toBe(1);
  });

  it('can return a NON-FINITE multiplier built from two finite floored factors', async () => {
    // 🔴 THE REASON THE SPENDING SITES CLAMP AT ALL. This function floors the BASE and then
    // multiplies; the product is never re-clamped. So "getMultipliersForUser already floors" is
    // true of its input and false of its output, and no read-side clamp can close it — the overflow
    // happens after. `String(Infinity)` reaching the Lua cap script is `tonumber` nil, which throws
    // out of `redis.eval` and into the user's mutation.
    //
    // Two earlier attempts to write down why the spending sites clamp were both wrong (a
    // `multiplierRaw` audit trail; a pending row read back by `process` — which cannot happen,
    // `isProcessable = !isOnDemand`). This is the one that holds, so it is asserted, not narrated.
    cached(1e308);
    h.getActiveRewardsBonusEvent.mockResolvedValue({ multiplier: 50 } as any);

    const result = await getMultipliersForUser(USER);

    expect(result.baseRewardsMultiplier).toBe(1e308);
    expect(result.globalRewardsBonus).toBe(5);
    expect(Number.isFinite(result.rewardsMultiplier)).toBe(false);
  });

  it('leaves a sub-1 multiplier alone', async () => {
    cached(0.5);

    expect((await getMultipliersForUser(USER)).rewardsMultiplier).toBe(0.5);
  });
});
