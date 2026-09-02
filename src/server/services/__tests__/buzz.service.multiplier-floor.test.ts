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
    // prints `expected 4 to be 8`. It does NOT separate a floor-at-0 from a floor-at-1 — clamp(4)
    // is 4 under either — so do not read it as doing that.
    cached(4);
    h.getActiveRewardsBonusEvent.mockResolvedValue({ multiplier: 20 } as any);

    const result = await getMultipliersForUser(USER);

    expect(result.baseRewardsMultiplier).toBe(4);
    expect(result.globalRewardsBonus).toBe(2);
    expect(result.rewardsMultiplier).toBe(8);
  });

  it('leaves a sub-1 multiplier alone', async () => {
    cached(0.5);

    expect((await getMultipliersForUser(USER)).rewardsMultiplier).toBe(0.5);
  });
});
