/**
 * Buzz is sold at a fixed ratio of 10 Buzz per USD cent ($1.00 = 1,000 Buzz).
 */
export const BUZZ_PER_USD_CENT = 10;

/**
 * Derive the USD charge, in whole cents, for a Buzz amount.
 *
 * Every payment provider we hand this value to expects an amount in the
 * currency's *minor unit*, which must be a whole number. Stripe rejects a
 * fraction outright (`Invalid integer: 1000.4`); Paddle, Coinbase and
 * EmerchantPay declare no integer bound on their input schemas at all, so a
 * fraction reaching them fails — if it fails — somewhere further out. The
 * division is the only place a fraction can be introduced: the Buzz amount is
 * free-typed, so anything that is not a multiple of 10 (e.g. 10,004) divides to
 * a fractional number of cents.
 *
 * Ceil, never round or floor: the buyer must never be granted more Buzz than
 * they are charged for. The submitted Buzz amount is re-derived from the value
 * returned here, so the pair stays consistent with the server-side
 * `unitAmount === buzzAmount / 10` tamper check.
 */
export function buzzAmountToUnitAmount(buzzAmount: number): number {
  return Math.ceil(buzzAmount / BUZZ_PER_USD_CENT);
}
