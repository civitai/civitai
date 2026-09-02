/**
 * Fit a reward multiplier to what the paying code can use: floor at 0, and a fallback for a value
 * that is not a number at all.
 *
 * 🔴 This is NOT `clampBuzzEventMultiplier`, and replacing it with one is not a cleanup — see
 * `base.reward.multiplier-floor.test.ts`. That helper carries the `buzzEvents.multiplier` column's
 * 9.99 ceiling, which belongs to a ClickHouse audit row. These values are PAID from: `sendAward`
 * computes `awardAmount * multiplier`, and a ceiling here would cap a legitimate 20x bonus event
 * (gold's 4 times MAX_GLOBAL_BONUS of 5) at 9.99.
 *
 * The floor is 0, not 1. A 0 multiplier is how `getMultipliersForUser` reports rewards-
 * ineligibility, and sub-1 products are intentional (see `foldUserMultipliers`).
 *
 * Non-finite falls back BY SIGN so the floor stays monotone, matching the shared helper's rule.
 * `Infinity` is not a harmless overflow on this path: it reaches the Redis Lua cap script as the
 * string `'Infinity'`, whose `tonumber` is nil, and the arithmetic on nil throws out of `redis.eval`
 * and into the user's mutation.
 *
 * What this does NOT do: a large-but-finite multiplier is left alone. Only a ceiling bounds that,
 * and a ceiling on a payout path is a product decision, not a guard.
 */
export function clampRewardMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier)) return multiplier < 0 ? 0 : 1;
  return Math.max(multiplier, 0);
}
