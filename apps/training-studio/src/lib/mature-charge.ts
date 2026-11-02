export type SpendCurrency = 'yellow' | 'green';

export type Spend = {
  amount: number;
  currency: SpendCurrency;
  uncertain: boolean;
  /** Yellow is charged only because the dataset is mature: the user must acknowledge it. */
  matureYellow: boolean;
};

/** How much of `price` comes out of a non-Blue account, Blue spending first. Null = nothing beyond Blue.
 *  A mature dataset never charges Green: the orchestrator refunds the Green part and charges Yellow, and a
 *  non-member's Blue is refunded too, so the whole price lands in Yellow. `blue` undefined = the balance
 *  couldn't be read, so assume the whole price may be non-Blue (fail safe). The one definition of
 *  "mature forces Yellow" for every quote, note and gate. */
export function matureSpend(args: {
  price: number | null | undefined;
  blue: number | undefined;
  mode: SpendCurrency;
  mature: boolean;
  member: boolean;
}): Spend | null {
  const { price, blue, mode, mature, member } = args;
  if (price == null || price <= 0) return null;
  const currency: SpendCurrency = mature ? 'yellow' : mode;
  if (mature && !member) return { amount: price, currency, uncertain: false, matureYellow: true };
  if (typeof blue !== 'number') {
    return { amount: price, currency, uncertain: true, matureYellow: mature };
  }
  if (price <= blue) return null;
  return {
    amount: price - Math.max(0, blue),
    currency,
    uncertain: false,
    matureYellow: mature,
  };
}

/** The tick belongs to one amount and one dataset; changing either un-ticks it. */
export function matureAckKey(spend: Spend | null, matureCount: number): string | null {
  return spend?.matureYellow ? `${spend.amount}:${matureCount}` : null;
}

/** Start is blocked while a mature-Yellow charge is unacknowledged. */
export function matureAckMissing(ackedFor: string | null, key: string | null): boolean {
  return key !== null && ackedFor !== key;
}
