/**
 * Buzz is sold at a fixed ratio of 10 Buzz per USD cent ($1.00 = 1,000 Buzz).
 */
export const BUZZ_PER_USD_CENT = 10;

/**
 * Derive the USD charge, in whole cents, for a Buzz amount.
 *
 * Every payment provider we hand this value to expects an amount in the
 * currency's *minor unit*, which must be a whole number. The division is the
 * only place a fraction can be introduced: the Buzz amount is free-typed, so
 * anything that is not a multiple of 10 (e.g. 10,004) divides to a fractional
 * number of cents.
 *
 * 🔴 THIS HELPER IS NOT THE ONLY DEFENCE, AND THE SCHEMAS ARE NOT INTERCHANGEABLE
 * WITH IT. All four provider input schemas that accept a `unitAmount` now carry
 * `.int()` — Stripe (`stripe.schema.ts`), Coinbase, EmerchantPay and Paddle — so a
 * fraction handed to one of THOSE routes is refused at our own trust boundary
 * rather than on Stripe alone. That was NOT true until it was measured: with this
 * helper bypassed, a fractional amount reached `coinbase.service.ts` and left as a
 * sub-cent `local_price.amount` of "10.004".
 *
 * 🔴 "Those routes" is not "every route". `coinbase.createCodeOrder` takes a
 * `buzzAmount` and no `unitAmount` at all, then divides by 10 inside
 * `coinbase.service.ts` — downstream of every schema bound above, so it can still
 * produce a sub-cent `local_price.amount`. It is unreached from the UI and
 * deliberately out of scope here. It is NOT covered.
 *
 * 🔴 Do NOT assume a provider's own tamper check covers this. Coinbase's
 * (`unitAmount !== buzzAmount / 10`) compares two values derived from the SAME
 * division, so a fractional pair is perfectly self-consistent and it passes. That
 * is structural rather than a sampled rate: every Buzz amount that is not a
 * multiple of ten yields such a pair, so there is no population on which the check
 * does better. The schema bound is the defence; the tamper check is blind to this
 * class.
 *
 * Ceil, never round or floor: the buyer must never be granted more Buzz than
 * they are charged for. The submitted Buzz amount is re-derived from the value
 * returned here, so the pair stays consistent with the server-side
 * `unitAmount === buzzAmount / 10` tamper check.
 */
export function buzzAmountToUnitAmount(buzzAmount: number): number {
  return Math.ceil(buzzAmount / BUZZ_PER_USD_CENT);
}
