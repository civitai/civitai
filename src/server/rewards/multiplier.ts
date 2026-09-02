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
 * The positive fallback is 1, so a NaN now PAYS the base award on the batch path where the old
 * `Math.ceil(award * NaN)` produced NaN and `sendAward`'s own `amount > 0` filter dropped it. That
 * is deliberate: one rule across every site beats two, and with the coercion below a NaN can no
 * longer be a misread quoted decimal, so the input is genuinely garbage rather than a legitimate
 * value in disguise. The alternative — treat it as `unqualified` and pay nothing — is defensible;
 * it was decided, not defaulted into.
 *
 * What this does NOT do: a large-but-finite multiplier is left alone. Only a ceiling bounds that,
 * and a ceiling on a payout path is a product decision, not a guard.
 */
export function clampRewardMultiplier(multiplier: number): number {
  // `Number()` first, and the parameter type is why. On the batch path this value is read back out
  // of a ClickHouse `Decimal(3, 2)`, where it is `number`-typed and string-valued at runtime.
  // `Number.isFinite('4.00')` is false, so testing the argument directly would send a legitimate 4x
  // down the non-finite fallback and pay 1x — the underpay `toClickhouseBuzzEvent` already had to
  // be fixed for once (f450100aba), reached here through a different reader.
  const raw = Number(multiplier);
  if (!Number.isFinite(raw)) return raw < 0 ? 0 : 1;
  return Math.max(raw, 0);
}
